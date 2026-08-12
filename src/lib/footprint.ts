// Building height + ground elevation via NYC Open Data Building Footprints.
//
// Source: NYC Building Footprints on the Socrata Open Data API (SODA), dataset
// id `5zhs-2jue`, a free, key-less endpoint. Fields we use:
//   - bin              : building identifier (join key from geocode)
//   - height_roof      : roof height above ground (ft in the source -> m here)
//   - ground_elevation : ground elevation, NAVD88 orthometric (ft -> m)
//   - the_geom         : footprint polygon (camera-anchor centroid + raycast)
//
// Vertical datum note: the published elevations are referenced to NAVD88 (the
// dataset metadata says "Based on the North American Vertical Datum of 1988").
// They are NOT WGS84 ellipsoidal heights; lib/geoid.ts does that conversion.
//
// Footprint data is GEOMETRY, not provider pixels — caching it would be
// permitted. It is simply not needed at this scale, so there is no cache.
//
// If a record is missing or lacks usable height, we surface "no-footprint" ->
// the honest unavailable state, never a guessed building. Footprint heights
// are used for camera placement ONLY; no code path extrudes them into a scene.
//
// Metadata: https://github.com/CityOfNewYork/nyc-geo-metadata/blob/main/Metadata/Metadata_BuildingFootprints.md

import type { BuildingFootprint } from "./types";
import { polygonCentroid } from "./geometry";

/** SODA endpoint for the Building Footprints dataset. */
export const SODA_URL = "https://data.cityofnewyork.us/resource/5zhs-2jue.json";

/**
 * The dataset publishes heights in US survey feet; everything downstream of
 * this module is metric.
 */
export const FEET_TO_METERS = 0.3048;

/** A SODA geometry column, as far as we read it. */
export interface SodaGeometry {
  type?: string;
  coordinates?: unknown;
}

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
 * Outer ring (`[lng, lat]` pairs) of a SODA Polygon or MultiPolygon, or null.
 *
 * For a Polygon that is `coordinates[0]`; for a MultiPolygon, the first
 * polygon's outer ring at `coordinates[0][0]`. Rings of fewer than three
 * points are rejected: they have no area, so a centroid or a facade raycast
 * taken from one is meaningless rather than merely imprecise.
 */
export function firstRing(
  geom: SodaGeometry | undefined,
): Array<[number, number]> | null {
  const coords = geom?.coordinates;
  if (!Array.isArray(coords)) return null;
  const ring =
    geom?.type === "MultiPolygon"
      ? (coords as number[][][][])[0]?.[0]
      : (coords as number[][][])[0];
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const typed = ring as Array<[number, number]>;
  if (!Array.isArray(typed[0]) || typed[0].length < 2) return null;
  return typed;
}

/** Parse a numeric SODA field that may arrive as a string, or be absent. */
export function num(v: string | undefined): number | null {
  if (v == null) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetch a building footprint by BIN. Throws FootprintError with a
 * discriminating `kind` so the pipeline routes both "no record" and "service
 * down" to the honest unavailable state.
 */
export async function fetchFootprintByBin(
  bin: string,
  signal?: AbortSignal,
): Promise<BuildingFootprint> {
  // `bin` is interpolated into a SoQL string literal below; encodeURIComponent
  // only makes the URL well-formed, it does not escape a `'` for SoQL. `bin`
  // is provider-supplied (the geocoder's join key), not raw user input, but
  // validating its known shape (NYC BINs are a 7-digit numeric string) before
  // it reaches the query string costs nothing and closes the gap regardless of
  // where the value came from.
  if (!/^\d{1,10}$/.test(bin)) {
    throw new FootprintError(`Malformed BIN: "${bin}"`, "network-error");
  }
  const url = `${SODA_URL}?$where=bin='${encodeURIComponent(bin)}'&$limit=1`;

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
 * tests — the ft->m conversion and the "missing height => no-footprint" rule
 * are exactly the kind of logic that must be proven, not trusted.
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
    // ground_elevation can legitimately be ~0 near the waterline; default 0.
    // This is an NAVD88 ORTHOMETRIC height, not an ellipsoidal one — see
    // lib/geoid.ts for the conversion the renderer needs.
    groundElevationNavd88M: (groundFt ?? 0) * FEET_TO_METERS,
    centroid: polygonCentroid(ring),
    // Keep the polygon ring so buildCameraViews can ray-cast to the actual
    // facade position rather than using a fixed small offset from the
    // centroid.
    ring,
  };
}
