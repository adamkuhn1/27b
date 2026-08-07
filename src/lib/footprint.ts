// Building height + ground elevation via NYC OpenData Building Footprints.
//
// Source: NYC Building Footprints on the Socrata Open Data API (SODA), dataset
// id `5zhs-2jue`, a free, key-less GeoJSON/JSON endpoint. Fields we use:
//   - bin            : building identifier (join key from geocode)
//   - height_roof    : roof height above ground (ft in the source -> meters here)
//   - ground_elevation : ground elevation, NAVD88 orthometric (ft -> meters)
//   - the_geom       : footprint polygon (used for the camera-anchor centroid)
//
// Vertical datum note: the published elevations are referenced to NAVD88 (the
// dataset metadata says "Based on the North American Vertical Datum of 1988").
// They are NOT WGS84 ellipsoidal heights; lib/geoid.ts does that conversion.
//
// If a record is missing or lacks usable height, we surface "no-footprint" ->
// the honest unavailable state, never a guessed building.
//
// The endpoint, the foot->metre factor and the ring extractor are shared with
// `neighbors.ts`, which reads the same dataset; see `lib/soda.ts`.

import type { BuildingFootprint } from "./types";
import { polygonCentroid } from "./geometry";
import {
  FEET_TO_METERS,
  SODA_URL,
  firstRing,
  num,
  type SodaGeometry,
} from "./soda";

/** Raw SODA record shape (only the fields we read). */
interface SodaFootprint {
  bin?: string;
  height_roof?: string;
  ground_elevation?: string;
  the_geom?: SodaGeometry;
}

export class FootprintError extends Error {
  constructor(
    message: string,
    readonly kind: "no-footprint" | "network-error",
  ) {
    super(message);
    this.name = "FootprintError";
  }
}

/**
 * Fetch a building footprint by BIN. Throws FootprintError with a discriminating
 * `kind` so the pipeline routes both "no record" and "service down" to the
 * honest unavailable state.
 */
export async function fetchFootprintByBin(
  bin: string,
  signal?: AbortSignal,
): Promise<BuildingFootprint> {
  // `bin` is interpolated into a SoQL string literal below; encodeURIComponent
  // only makes the URL well-formed, it does not escape a `'` for SoQL. `bin`
  // is provider-supplied (the geocoder's join key), not raw user input, but
  // validating its known shape (NYC BINs are a 7-digit numeric string) before
  // it ever reaches the query string costs nothing and closes the gap
  // regardless of where the value came from.
  if (!/^\d{1,10}$/.test(bin)) {
    throw new FootprintError(`Malformed BIN: "${bin}"`, "network-error");
  }
  const url = `${SODA_URL}?$where=bin='${encodeURIComponent(
    bin,
  )}'&$limit=1`;

  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new FootprintError(
      "Could not reach the NYC building-data service.",
      "network-error",
    );
  }

  if (!res.ok) {
    throw new FootprintError(
      `Building-data service returned ${res.status}.`,
      "network-error",
    );
  }

  let rows: SodaFootprint[];
  try {
    rows = (await res.json()) as SodaFootprint[];
  } catch {
    throw new FootprintError(
      "Malformed response from building-data service.",
      "network-error",
    );
  }

  const row = rows[0];
  if (!row) {
    throw new FootprintError(
      "No building footprint on file for this address yet.",
      "no-footprint",
    );
  }

  return parseFootprint(row, bin);
}

/**
 * Convert a raw SODA row into a BuildingFootprint (meters). Exported for unit
 * tests — the ft->m conversion and the "missing height => no-footprint" rule are
 * exactly the kind of logic that must be proven, not trusted.
 */
export function parseFootprint(
  row: SodaFootprint,
  bin: string,
): BuildingFootprint {
  const roofFt = num(row.height_roof);
  const groundFt = num(row.ground_elevation);

  // A footprint with no usable roof height can't place a floor camera. Refuse
  // rather than invent a height.
  if (roofFt == null || roofFt <= 0) {
    throw new FootprintError(
      "This building has no height on file, so we can't place the view.",
      "no-footprint",
    );
  }

  const ring = firstRing(row.the_geom);
  if (!ring) {
    throw new FootprintError(
      "This building's footprint shape is missing.",
      "no-footprint",
    );
  }

  return {
    bin: row.bin ?? bin,
    roofHeightM: roofFt * FEET_TO_METERS,
    // GROUNDELEV can legitimately be ~0 near the waterline; default to 0.
    // This is an NAVD88 ORTHOMETRIC height, not an ellipsoidal one — see
    // lib/geoid.ts for the conversion the renderer needs.
    groundElevationNavd88M: (groundFt ?? 0) * FEET_TO_METERS,
    centroid: polygonCentroid(ring),
    // Keep the polygon ring so buildCameraViews can ray-cast to the actual
    // facade position rather than using a fixed small offset from the centroid.
    ring,
  };
}
