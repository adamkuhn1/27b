// Shared domain types for the 27B pipeline.
//
// The pipeline is intentionally split into two halves that never blur together:
//   - geometry (must be real): geocode -> footprint/height -> camera math
//   - presentation (the raw Google 3D Tiles render placed at that camera)
// Every type here belongs to the geometry half and is fully unit-testable
// without any API key. The anti-fabrication guarantee lives in this split: no
// type in this file can produce a scene; they only ever describe *where a real
// camera goes*.

/**
 * The four view slots we render. These are *positions in the result grid*, not
 * compass directions — the actual bearing of each slot depends on the building
 * (see `ViewBasis`). Naming them V1..V4 rather than N/E/S/W is deliberate: the
 * old naming hard-coded the assumption that a window faces true north, which is
 * false for essentially every building on the Manhattan grid (rotated ~29deg).
 */
export type ViewSlot = "V1" | "V2" | "V3" | "V4";

export const VIEW_SLOTS: readonly ViewSlot[] = ["V1", "V2", "V3", "V4"] as const;

/**
 * How the four view bearings were chosen.
 *
 * - `facade`: the footprint has a dominant rectilinear orientation, so the four
 *   views look out along the outward normals of the building's own facades —
 *   i.e. roughly what you'd see standing at a window. Bearings are still real
 *   compass bearings and are labelled as such.
 * - `compass`: the footprint has no dominant orientation (round, highly
 *   irregular, or too few edges), so we fall back to true N/E/S/W and say so.
 *   We never pretend a facade exists that the footprint doesn't support.
 */
export type ViewBasis = "facade" | "compass";

/** 16-point compass abbreviations, index = round(bearing / 22.5) mod 16. */
export const COMPASS_16 = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
] as const;

export type Compass16 = (typeof COMPASS_16)[number];

/** Nearest 16-point compass abbreviation for a true bearing in degrees. */
export function compassLabel(bearingDeg: number): Compass16 {
  const norm = ((bearingDeg % 360) + 360) % 360;
  return COMPASS_16[Math.round(norm / 22.5) % 16];
}

/** A geocoded NYC address. lat/lng are WGS84 decimal degrees. */
export interface GeocodeResult {
  /** The label the geocoder resolved (canonical, may differ from input). */
  label: string;
  lat: number;
  lng: number;
  /** NYC Building Identification Number, when the geocoder returns one. */
  bin?: string;
  /** Borough name, when available (used for a friendly display + NYC gate). */
  borough?: string;
}

/**
 * Building geometry from NYC OpenData Building Footprints.
 *
 * Heights are meters. `groundElevationNavd88M` is an ORTHOMETRIC height
 * (NAVD88), because that is what the source dataset publishes — see
 * `lib/geoid.ts` for the conversion to the ellipsoidal height Cesium needs.
 */
export interface BuildingFootprint {
  bin: string;
  /** HEIGHTROOF: roof height above ground, meters. */
  roofHeightM: number;
  /** GROUNDELEV: ground elevation, meters above the NAVD88 geoid. */
  groundElevationNavd88M: number;
  /** Footprint centroid (WGS84), used as the camera anchor. */
  centroid: { lat: number; lng: number };
  /**
   * Outer footprint polygon ring as [lng, lat] pairs. Stored so geometry can
   * ray-cast from the centroid to find the actual facade distance in each
   * direction — instead of assuming a fixed offset (which puts the camera
   * inside large buildings like ESB whose footprint spans 60+ m across).
   */
  ring: Array<[number, number]>;
}

/**
 * The resolved camera vantage for one view. This is the geometry the Cesium
 * viewer consumes verbatim — real coordinates, real elevation, a real bearing.
 * No scene data is implied.
 */
export interface CameraView {
  slot: ViewSlot;
  /** True compass bearing the camera looks along (0 = true north, clockwise). */
  headingDeg: number;
  /** 16-point compass label for `headingDeg` (display only). */
  compass: Compass16;
  /** Camera position: real lat/lng, just outside the facade it looks out from. */
  lat: number;
  lng: number;
  /**
   * WGS84 **ellipsoidal** height (m) — the value Cesium consumes. Derived from
   * the NAVD88 floor elevation via the GEOID18 conversion in lib/geoid.ts.
   */
  heightM: number;
  /** Pitch in degrees; 0 = looking at the horizon, negative = looking down. */
  pitchDeg: number;
  /** Meters from the footprint centroid to the camera along `headingDeg`. */
  standoffM: number;
}

/**
 * Everything the geometry half produces for a request. This object is fully
 * derived from real data; it is the contract handed to the renderer.
 */
export interface ViewPlan {
  address: string;
  floor: number;
  geocode: GeocodeResult;
  footprint: BuildingFootprint;
  /** Eye elevation in the SOURCE datum (NAVD88 orthometric), meters. */
  eyeElevationNavd88M: number;
  /** Eye elevation as WGS84 ellipsoidal height (what the renderer uses). */
  eyeElevationEllipsoidalM: number;
  /** GEOID18 undulation applied at this building (m; ~-31.7 in NYC). */
  geoidHeightM: number;
  /** True when the floor was clamped to the building roof (documented approx). */
  floorClampedToRoof: boolean;
  /** How the four bearings were chosen — surfaced in the UI, never implied. */
  basis: ViewBasis;
  views: CameraView[];
}

/** Discriminated result of the geometry pipeline. */
export type ViewPlanResult =
  | { ok: true; plan: ViewPlan; fromCache: boolean }
  | { ok: false; reason: UnavailableReason; message: string };

/**
 * Why a plan could not be produced. Every branch maps to the SAME honest
 * "not available" UI state — there is deliberately no branch that yields a
 * fabricated fallback scene.
 */
export type UnavailableReason =
  | "not-nyc" // address is outside NYC / validation failed
  | "geocode-failed" // address could not be resolved
  | "no-footprint" // no building footprint/height record found
  | "network-error"; // upstream data service failed
