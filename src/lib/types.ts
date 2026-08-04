// Shared domain types for the 27B pipeline.
//
// The pipeline is intentionally split into two halves that never blur together:
//   - geometry (must be real): geocode -> footprint/height -> camera math
//   - presentation (the raw Google 3D Tiles render placed at that camera)
// Every type here belongs to the geometry half and is fully unit-testable
// without any API key. The anti-fabrication guarantee lives in this split: no
// type in this file can produce a scene; they only ever describe *where a real
// camera goes*.

/** The four building-relative cardinal directions we render. */
export type Cardinal = "N" | "E" | "S" | "W";

/** Compass heading in degrees for each cardinal (0 = north, clockwise). */
export const CARDINAL_HEADING: Record<Cardinal, number> = {
  N: 0,
  E: 90,
  S: 180,
  W: 270,
};

export const CARDINALS: readonly Cardinal[] = ["N", "E", "S", "W"] as const;

export const CARDINAL_LABEL: Record<Cardinal, string> = {
  N: "North",
  E: "East",
  S: "South",
  W: "West",
};

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
 * Heights are meters above ground; groundElevationM is meters above sea level.
 */
export interface BuildingFootprint {
  bin: string;
  /** HEIGHTROOF: roof height above ground, meters. */
  roofHeightM: number;
  /** GROUNDELEV: ground elevation above sea level, meters. */
  groundElevationM: number;
  /** Footprint centroid (WGS84), used as the camera anchor. */
  centroid: { lat: number; lng: number };
  /**
   * Outer footprint polygon ring as [lng, lat] pairs. Stored so geometry can
   * ray-cast from the centroid to find the actual facade distance in each
   * cardinal direction — instead of assuming 6 m (which puts the camera inside
   * large buildings like ESB whose footprint spans 60+ m from centroid to edge).
   */
  ring: Array<[number, number]>;
}

/**
 * The resolved camera vantage for one cardinal view. This is the geometry the
 * Cesium viewer consumes verbatim — real coordinates, real elevation, a fixed
 * heading. No scene data is implied.
 */
export interface CameraView {
  cardinal: Cardinal;
  headingDeg: number;
  /** Camera position: real lat/lng nudged just outside the facade. */
  lat: number;
  lng: number;
  /** Ellipsoidal height (m above sea level) at the chosen floor. */
  heightM: number;
  /** Pitch in degrees; 0 = looking at the horizon. */
  pitchDeg: number;
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
  /** Camera-eye elevation (m above sea level) at the requested floor. */
  eyeElevationM: number;
  /** True when the floor was clamped to the building roof (documented approx). */
  floorClampedToRoof: boolean;
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
