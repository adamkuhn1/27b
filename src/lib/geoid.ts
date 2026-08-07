// Vertical-datum conversion: NAVD88 orthometric height -> WGS84 ellipsoidal height.
//
// WHY THIS FILE EXISTS (this was a real, ~32 m bug):
//
// NYC Building Footprints publishes `ground_elevation` in feet referenced to the
// North American Vertical Datum of 1988 (NAVD88) — an *orthometric* height,
// measured from the geoid ("mean sea level"). Source:
// https://github.com/CityOfNewYork/nyc-geo-metadata/blob/main/Metadata/Metadata_BuildingFootprints.md
// ("Based on the North American Vertical Datum of 1988").
//
// Cesium's `Cartesian3.fromDegrees(lng, lat, height)` — and therefore every
// camera we place inside Google's Photorealistic 3D Tiles, which are
// georeferenced in ECEF/WGS84 — expects an *ellipsoidal* height, measured from
// the WGS84 ellipsoid.
//
// The two differ by the geoid undulation N:
//
//     h (ellipsoidal) = H (orthometric, NAVD88) + N (geoid height)
//
// That addition is done once, at the single place that needs it —
// `estimateFloorElevation` in `lib/geometry.ts`, which also reports N in its
// own right. A `navd88ToEllipsoidalM(H, lat, lng)` wrapper used to live here
// and had no callers: the one real caller needs N separately, so going through
// the wrapper would have meant sampling the lattice twice for one camera.
//
// Over New York City N is about **-31 m to -32.5 m**. Passing an NAVD88 height
// straight into Cesium therefore placed every camera roughly **32 m too high** —
// about ten floors of error, in a product whose entire premise is "which floor
// are you on." The floor number still changed the output before this fix, but
// with a large constant bias on top; the fix removes the bias.
//
// HOW THE GRID WAS PRODUCED (reproducible):
//
// Values are GEOID18 (the hybrid model for NAVD88 in CONUS) sampled from NOAA
// NGS's public Geoid Height Service on 2026-08-04:
//
//     https://geodesy.noaa.gov/api/geoid/ght?lat=<lat>&lon=<lon>
//     (API docs: https://geodesy.noaa.gov/web_services/geoid.shtml)
//
// on a 0.1-degree lattice covering the five boroughs. Bilinear interpolation of
// this lattice was validated against 8 independent NOAA queries (Empire State
// Building, One WTC, 432 Park, Bed-Stuy, Jamaica, the Bronx, Staten Island, the
// Upper East Side): **max error 0.031 m**, i.e. ~1% of one floor. That is far
// below the 3.2 m floor-height assumption this app already discloses, so a
// baked-in lattice is preferable to a per-request network dependency on NOAA.

/** Southern edge of the lattice (degrees). */
export const GEOID_LAT0 = 40.4;
/** Western edge of the lattice (degrees). */
export const GEOID_LON0 = -74.3;
/** Lattice spacing (degrees). */
export const GEOID_STEP = 0.1;

/**
 * GEOID18 geoid heights (meters) on the lattice, row-major from south to north,
 * each row west to east. rows: lat 40.4 .. 41.0, cols: lon -74.3 .. -73.6.
 */
export const GEOID18_NYC: readonly (readonly number[])[] = [
  [-32.452, -32.346, -32.396, -32.555, -32.618, -32.472, -32.29, -32.186],
  [-32.557, -32.374, -32.307, -32.394, -32.468, -32.362, -32.173, -32.008],
  [-32.633, -32.376, -32.167, -32.102, -32.133, -32.122, -31.997, -31.781],
  [-32.649, -32.398, -32.115, -31.857, -31.697, -31.676, -31.656, -31.519],
  [-32.577, -32.365, -32.091, -31.742, -31.477, -31.332, -31.274, -31.188],
  [-32.492, -32.31, -32.051, -31.692, -31.353, -31.133, -31.017, -30.905],
  [-32.31, -32.165, -31.965, -31.656, -31.295, -30.978, -30.781, -30.65],
];

const N_ROWS = GEOID18_NYC.length;
const N_COLS = GEOID18_NYC[0].length;

/**
 * GEOID18 geoid height (meters, negative over NYC) at a WGS84 lat/lng, by
 * bilinear interpolation of the baked lattice. Coordinates outside the lattice
 * are clamped to its edge — the caller (validation.ts) has already rejected
 * anything outside the NYC bounding box, so clamping only ever affects points
 * within a tenth of a degree of the edge, where the field is smooth.
 */
export function geoidHeightM(lat: number, lng: number): number {
  const fi = (lat - GEOID_LAT0) / GEOID_STEP;
  const fj = (lng - GEOID_LON0) / GEOID_STEP;

  const i = Math.min(Math.max(Math.floor(fi), 0), N_ROWS - 2);
  const j = Math.min(Math.max(Math.floor(fj), 0), N_COLS - 2);
  const ti = Math.min(Math.max(fi - i, 0), 1);
  const tj = Math.min(Math.max(fj - j, 0), 1);

  const g00 = GEOID18_NYC[i][j];
  const g01 = GEOID18_NYC[i][j + 1];
  const g10 = GEOID18_NYC[i + 1][j];
  const g11 = GEOID18_NYC[i + 1][j + 1];

  return (
    g00 * (1 - ti) * (1 - tj) +
    g01 * (1 - ti) * tj +
    g10 * ti * (1 - tj) +
    g11 * ti * tj
  );
}
