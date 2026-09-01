// Shared frontend types for the 27B API contract + render/UI state.
//
// The geometry pipeline (geocode, footprint fetch, elevation math, facade
// math) lives in the Python backend (backend/planning.py +
// backend/geometry.py) behind POST /api/view-plan. These types are the
// typed shape of that contract, plus the presentation types (CaptureResult,
// ViewState) for the Google 3D Tiles render placed at the camera the
// backend returns. No type here can produce a scene -- they only describe
// where a real camera goes and what the renderer did with it.

/**
 * The four view slots in the result grid. These are grid positions, not
 * compass directions -- the actual bearing of each slot depends on the
 * building (see `ViewBasis`). Naming them V1..V4 rather than N/E/S/W is
 * deliberate: the building-relative bearings on the Manhattan grid sit ~29°
 * off true north.
 */
export type ViewSlot = "V1" | "V2" | "V3" | "V4";

export const VIEW_SLOTS: readonly ViewSlot[] = ["V1", "V2", "V3", "V4"] as const;

/**
 * How the four view bearings were chosen.
 *
 * - `facade`: the footprint has a dominant rectilinear orientation, so views
 *   look out along the outward normals of the building's own walls.
 * - `compass`: the footprint has no dominant orientation, so the backend
 *   falls back to true N/E/S/W and says so. Never a facade the footprint
 *   doesn't support.
 */
export type ViewBasis = "facade" | "compass";

/** A geocoded NYC address, as resolved by the backend. lat/lng are WGS84
 *  decimal degrees. */
export interface GeocodeResult {
  label: string;
  lat: number;
  lng: number;
  bin?: string;
  borough?: string;
}

/** Building footprint summary -- the backend keeps the full polygon ring
 *  (used only for its own camera math) server-side; this is what crosses
 *  the wire. */
export interface FootprintSummary {
  bin: string;
  roofHeightM: number;
  groundElevationNavd88M: number;
  centroid: { lat: number; lng: number };
}

/**
 * The resolved camera vantage for one view. This is what the Cesium viewer
 * consumes verbatim -- real coordinates, real elevation, a real bearing. No
 * scene data is implied.
 */
export interface CameraView {
  slot: ViewSlot;
  /** True compass bearing the camera looks along (0 = true north, clockwise). */
  headingDeg: number;
  /** 16-point compass label for `headingDeg` (display only). */
  compass: string;
  /** Camera position: real lat/lng, just outside the facade it looks out from. */
  lat: number;
  lng: number;
  /**
   * WGS84 **ellipsoidal** height (m) -- the value Cesium consumes. The
   * backend derives this from the NAVD88 floor elevation via a GEOID18
   * conversion (backend/geometry.py).
   */
  heightM: number;
  /** Pitch in degrees; 0 = horizon, negative = looking down. */
  pitchDeg: number;
  /** Meters from the footprint centroid to the camera along `headingDeg`. */
  standoffM: number;
}

/**
 * Everything the backend's geometry pipeline produces for a request, plus
 * the curated-list entry that authorised the render. Fully derived from
 * real data; this is the contract handed to the renderer.
 */
export interface ViewPlan {
  address: string;
  floor: number;
  geocode: GeocodeResult;
  footprint: FootprintSummary;
  /** The curated building this plan matched (renders are curated-only). */
  curatedName: string;
  /** Eye elevation in the SOURCE datum (NAVD88 orthometric), meters. */
  eyeElevationNavd88M: number;
  /** Eye elevation as WGS84 ellipsoidal height (what the renderer uses). */
  eyeElevationEllipsoidalM: number;
  /** GEOID18 undulation applied at this building (m; ~-31.7 in NYC). */
  geoidHeightM: number;
  /** True when the floor was clamped to the building roof. */
  floorClampedToRoof: boolean;
  /** How the four bearings were chosen -- surfaced in the UI, never implied. */
  basis: ViewBasis;
  views: CameraView[];
}

/**
 * Why a plan could not be produced. Every branch maps to an honest
 * "not available" UI state -- there is deliberately no branch that yields a
 * fabricated fallback scene.
 */
export type UnavailableReason =
  | "not-nyc" // address is outside NYC / validation failed
  | "geocode-failed" // address could not be resolved
  | "no-footprint" // no building footprint/height record found
  | "network-error" // upstream data service failed
  | "not-supported"; // real address, but outside the curated supported set

/** Discriminated result of POST /api/view-plan; lib/api.ts reshapes the
 *  backend's flat JSON body into this union so callers narrow on `.ok`. */
export type ViewPlanResult =
  | { ok: true; plan: ViewPlan }
  | {
      ok: false;
      reason: UnavailableReason;
      message: string;
      /**
       * For `not-supported` only: the floor window that IS verified at this
       * building, when the address matched a curated building but the floor
       * fell outside its verified range.
       */
      supportedFloors?: { min: number; max: number };
    };

/** One entry in the supported-building list (GET /api/curated-buildings),
 *  rendered as the picker chips and the not-supported state's list. */
export interface CuratedBuilding {
  name: string;
  address: string;
  bin: string;
  floors: { min: number; max: number };
  suggestedFloor: number;
  note: string;
  verifiedAt: string;
}

// ---------------------------------------------------------------------------
// Render outcomes — the contract between the Cesium renderer and the UI
// ---------------------------------------------------------------------------

/** One finished frame. */
export interface CaptureResult {
  slot: ViewSlot;
  /** data: URL PNG of the frame, attribution baked along the bottom. */
  dataUrl: string;
  /**
   * The data attributions Google returned for the tiles actually displayed in
   * this frame (e.g. ["Google", "Vexcel Imaging US, Inc."]). Map Tiles API
   * policies require these to be displayed with the imagery.
   */
  attribution: string[];
}

/** Where one direction stands with the renderer, as shown in the UI. */
export type ViewState =
  | { kind: "pending" }
  | { kind: "capturing" }
  | { kind: "ready"; result: CaptureResult }
  /**
   * The render failed or drew no provider geometry. The UI shows this as an
   * explicit "didn't load" — never a placeholder image, never a synthetic
   * scene. `detail` is an operator diagnostic (key-redacted); it goes to the
   * console, not the screen.
   */
  | { kind: "failed"; detail: string };
