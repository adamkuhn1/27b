// Neighbouring building footprints, for the per-direction enclosure assessment.
//
// Same dataset as the subject building (NYC Open Data Building Footprints,
// `5zhs-2jue`, free and keyless): asking for the buildings *around* an address
// is the same public call as asking for the building *at* it. Nothing here
// touches a provider endpoint, so nothing here is metered and nothing here is
// restricted. That is the whole reason the confidence layer is built on this
// data rather than on the imagery — see the header of `lib/confidence.ts`.
//
// -----------------------------------------------------------------------------
// THE TRAP IN THE OBVIOUS QUERY
// -----------------------------------------------------------------------------
//
// SoQL's `within_circle(the_geom, lat, lng, radius)` on a *polygon* column means
// "the polygon lies entirely inside the circle", not "the polygon intersects the
// circle". Used naively for obstruction analysis it silently omits every large
// neighbour that straddles the query radius — which is precisely the set of
// buildings that block a view.
//
// Measured against the live endpoint on 2026-08-05, centred on the Empire State
// Building's own centroid (40.7484410, -73.9857531):
//
//     within_circle(the_geom, ..., 40)  ->    0 rows   (the ESB is NOT returned)
//     within_circle(the_geom, ..., 150) ->   41 rows   (the ESB is returned)
//     intersects(the_geom, <220 m box>) ->  202 rows, 161,876 bytes, 1.27 s
//
// The ESB's footprint half-diagonal is about 96 m, so it falls out of a 40 m
// circle while sitting directly on top of it. `intersects()` with an explicit
// WKT box is used instead, and `neighbors.test.ts` pins the case with a fixture
// containing a straddling neighbour.
//
// -----------------------------------------------------------------------------
// DATA QUALITY
// -----------------------------------------------------------------------------
//
// Two absences matter and are handled differently:
//
//   * No `ground_elevation` field at all (absent, not null). Falling back to 0
//     understates the building's top by up to ~60 m in the Bronx and Staten
//     Island. We fall back to the *subject building's* ground elevation, which
//     is within a few metres for anything this close.
//   * No `height_roof`. The building is SKIPPED and the report is flagged
//     incomplete. A building of unknown height is an unknown, and the honest
//     handling is to reduce confidence in the answer — not to assert open sky
//     by treating it as zero-height.

import type { NeighborBuilding } from "./types";

const SODA_URL = "https://data.cityofnewyork.us/resource/5zhs-2jue.json";

const FEET_TO_METERS = 0.3048;

/** Metres per degree of latitude (WGS84 mean). */
const M_PER_DEG_LAT = 111_320;

/**
 * Hard cap on rows. The densest measured query (Midtown, 220 m) returned 202;
 * 1,500 leaves a wide margin while refusing to page an unbounded response into
 * a browser tab.
 */
const ROW_LIMIT = 1500;

export class NeighborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeighborError";
  }
}

interface SodaRow {
  bin?: string;
  height_roof?: string;
  ground_elevation?: string;
  the_geom?: { type?: string; coordinates?: unknown };
}

/** A WKT axis-aligned box `radiusM` around a point, for `intersects()`. */
export function wktBox(
  lat: number,
  lng: number,
  radiusM: number,
): string {
  const dLat = radiusM / M_PER_DEG_LAT;
  const dLng = radiusM / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  const s = (lat - dLat).toFixed(7);
  const n = (lat + dLat).toFixed(7);
  const w = (lng - dLng).toFixed(7);
  const e = (lng + dLng).toFixed(7);
  // WKT is (x y) = (lng lat), closed ring.
  return `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`;
}

/** Outer ring of a SODA Polygon/MultiPolygon geometry, or null. */
function firstRing(geom: SodaRow["the_geom"]): Array<[number, number]> | null {
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

function num(v: string | undefined): number | null {
  if (v == null) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export interface NeighborSet {
  neighbors: NeighborBuilding[];
  /** True when at least one record was skipped for lack of a roof height. */
  incomplete: boolean;
}

/**
 * Turn raw SODA rows into usable neighbours. Exported because the skip rules
 * are exactly the kind of logic that has to be proven rather than trusted.
 */
export function parseNeighbors(rows: SodaRow[]): NeighborSet {
  const neighbors: NeighborBuilding[] = [];
  let incomplete = false;

  for (const row of rows) {
    const ring = firstRing(row.the_geom);
    if (!ring) {
      incomplete = true;
      continue;
    }
    const roofFt = num(row.height_roof);
    if (roofFt == null || roofFt <= 0) {
      // Unknown height, not zero height. Flag and move on.
      incomplete = true;
      continue;
    }
    const groundFt = num(row.ground_elevation);
    neighbors.push({
      bin: row.bin ?? "",
      ring,
      roofHeightM: roofFt * FEET_TO_METERS,
      groundElevationNavd88M:
        groundFt == null ? null : groundFt * FEET_TO_METERS,
    });
  }

  return { neighbors, incomplete };
}

/**
 * Fetch every footprint intersecting a box `radiusM` around a point.
 *
 * Throws `NeighborError` on any failure. The caller degrades to "no notes
 * available" — a missing enclosure assessment must never turn into a missing
 * result, and must never be read as "open".
 */
export async function fetchNeighbors(
  lat: number,
  lng: number,
  radiusM: number,
  signal?: AbortSignal,
): Promise<NeighborSet> {
  const where = `intersects(the_geom,'${wktBox(lat, lng, radiusM)}')`;
  const url =
    `${SODA_URL}?$select=${encodeURIComponent("bin,height_roof,ground_elevation,the_geom")}` +
    `&$where=${encodeURIComponent(where)}&$limit=${ROW_LIMIT}`;

  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new NeighborError("Could not reach the NYC building-data service.");
  }
  if (!res.ok) {
    throw new NeighborError(`Building-data service returned ${res.status}.`);
  }
  try {
    return parseNeighbors((await res.json()) as SodaRow[]);
  } catch {
    throw new NeighborError("Malformed response from building-data service.");
  }
}
