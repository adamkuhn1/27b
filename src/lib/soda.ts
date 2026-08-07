// Shared access details for NYC Open Data Building Footprints.
//
// The subject building (`footprint.ts`) and its neighbours (`neighbors.ts`) come
// from the same dataset — `5zhs-2jue` on the Socrata Open Data API, free and
// keyless — and used to carry their own copies of the endpoint, the foot->metre
// factor and the ring extractor. The two ring extractors had drifted apart:
// one rejected a ring of fewer than three points, the other accepted it and
// handed a degenerate "polygon" to the centroid and raycast code. A footprint
// with two points is not a footprint, so the strict rule is the correct one and
// is now the only one.
//
// The previous dataset `nqwf-w8eh` was retired by NYC; `5zhs-2jue` is the
// current Building Footprints dataset, with renamed fields.
//
// Metadata: https://github.com/CityOfNewYork/nyc-geo-metadata/blob/main/Metadata/Metadata_BuildingFootprints.md

/** SODA endpoint for the Building Footprints dataset. */
export const SODA_URL = "https://data.cityofnewyork.us/resource/5zhs-2jue.json";

/**
 * The dataset publishes heights in US survey feet; everything downstream of
 * these two modules is metric.
 */
export const FEET_TO_METERS = 0.3048;

/** A SODA geometry column, as far as either caller reads it. */
export interface SodaGeometry {
  type?: string;
  coordinates?: unknown;
}

/**
 * Outer ring (`[lng, lat]` pairs) of a SODA Polygon or MultiPolygon, or null.
 *
 * For a Polygon that is `coordinates[0]`; for a MultiPolygon, the first
 * polygon's outer ring at `coordinates[0][0]`. Rings of fewer than three points
 * are rejected: they have no area, so a centroid or a facade raycast taken from
 * one is meaningless rather than merely imprecise.
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
