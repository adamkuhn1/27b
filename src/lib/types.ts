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
 * A neighbouring building, from the same NYC Open Data Building Footprints
 * dataset as the subject. Free, keyless, and ours to query — it carries no
 * provider restriction of any kind, which is exactly why the confidence layer
 * is built on it (see lib/confidence.ts).
 */
export interface NeighborBuilding {
  bin: string;
  /** Outer footprint ring as [lng, lat] pairs. */
  ring: Array<[number, number]>;
  /** HEIGHTROOF: roof height above its own ground, metres. */
  roofHeightM: number;
  /**
   * GROUNDELEV in metres (NAVD88), or `null` when the field is absent from the
   * record. Absent is common enough to matter and is NOT the same as zero:
   * defaulting to 0 understates a building's top by up to ~60 m in the Bronx
   * and Staten Island.
   */
  groundElevationNavd88M: number | null;
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
 * How enclosed one direction is, from neighbouring building geometry.
 *
 * Derived **only** from NYC Open Data footprints and our own arithmetic. No
 * pixel of provider imagery is examined and no ray is cast against the provider
 * mesh — see the header of `lib/confidence.ts` for why that is not a stylistic
 * choice.
 */
export type EnclosureBand = "open" | "partly-enclosed" | "enclosed";

export interface DirectionConfidence {
  slot: ViewSlot;
  band: EnclosureBand;
  /**
   * Greatest angle above the camera's eye line subtended by a neighbouring
   * roof inside the view cone, in degrees. Negative means nothing within the
   * search radius reaches the eye line at all; the sentinel `-90` means no
   * neighbouring building fell inside the cone at all.
   */
  maxObstructionAngleDeg: number;
  /**
   * Horizontal distance to the nearest neighbour that rises above the eye
   * line, in metres. `null` when nothing inside the search radius does.
   */
  firstBlockingM: number | null;
  /**
   * Metres of a neighbouring building standing above the eye **at the camera's
   * own position** — i.e. the camera is inside that building's footprint and
   * below its roof. `null` in the ordinary case.
   *
   * This is the party-wall condition, and in NYC it is common rather than
   * exotic: row and infill buildings share lot lines, so one to three of a
   * building's four "facades" can be solid wall buried in the building next
   * door. There is no window there, so there is no view — and a camera placed
   * six metres beyond such a facade is not outdoors, it is inside the
   * neighbour's mesh. The renderer skips these directions rather than
   * capturing the inside of a building and presenting it as a view.
   */
  insideNeighborByM: number | null;
}

/** The per-plan result of the confidence pass. */
export interface ConfidenceReport {
  bySlot: Partial<Record<ViewSlot, DirectionConfidence>>;
  /**
   * True when at least one neighbour inside the search area had no roof height
   * on file and was therefore skipped. A skipped building is an unknown, so the
   * UI says the notes may miss an obstruction rather than implying open sky.
   */
  neighborDataIncomplete: boolean;
  /** How many neighbouring buildings contributed to the assessment. */
  neighborsConsidered: number;
  /** Horizontal search radius used, metres. */
  searchRadiusM: number;
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
  /**
   * Length-weighted orientation concentration of the footprint, 0..1 (see
   * `principalFacadeAxis`). 1.0 = a perfect rectangle; the Flatiron measures
   * 0.60. Carried through because "how well do four bearings actually fit this
   * building" is a real measurement about an unusual building, and the visitor
   * never used to see it.
   */
  facadeConcentration: number;
  views: CameraView[];
  /**
   * Per-direction enclosure assessment, or `null` when the neighbour lookup
   * failed or timed out. `null` means "no notes available" — never a missing
   * result and never an assumed-open view.
   */
  confidence: ConfidenceReport | null;
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

// ---------------------------------------------------------------------------
// Render session — the streaming contract between the Cesium renderer and the UI
// ---------------------------------------------------------------------------

/** One finished frame. */
export interface CaptureResult {
  slot: ViewSlot;
  /** data: URL PNG of the rendered frame, with attribution baked along the bottom. */
  dataUrl: string;
  /**
   * The data attributions Google returned for the tiles actually displayed in
   * this frame (e.g. ["Google", "Vexcel Imaging US, Inc."]). Kept as separate
   * credits rather than one joined string so they can be de-duplicated across
   * frames without splitting on a comma that belongs inside a company name.
   * Map Tiles API policies require these to be displayed with the imagery.
   */
  attribution: string[];
}

/**
 * Why one capture failed.
 *
 * `fatalForSession` is the load-bearing field: a canvas-readback taint will
 * fail identically for every remaining direction, so retrying it is a waste of
 * the visitor's time, whereas a single view that never settled might well work
 * on a second pass.
 */
export interface RenderFailure {
  kind: "capture-failed" | "readback-blocked";
  /**
   * Operator diagnostic with any `key=` query parameter redacted. Goes to the
   * console; it is never rendered on screen.
   */
  detail: string;
  fatalForSession: boolean;
}

/**
 * Events a render session emits, in order.
 *
 * An async iterable of these rather than a `Promise<CaptureResult[]>` is what
 * makes partial success expressible *in the type*: "three landed, one didn't"
 * is a sequence of events, not a rejected promise or a convention about a
 * short array.
 */
export type CaptureEvent =
  | {
      kind: "session-open";
      /**
       * Root tileset requests this session has cost. Exactly 1: the billable
       * unit for Photorealistic 3D Tiles is the session, not the frame, so
       * every capture and every in-session retry below is free. Asserted in
       * renderSession.test.ts rather than trusted.
       */
      rootRequests: number;
    }
  | { kind: "view-started"; slot: ViewSlot; attempt: number }
  | {
      kind: "view-captured";
      result: CaptureResult;
      /**
       * True when the capture ended because tile activity went quiet, false
       * when the hard timeout fired first. This is our own render loop's
       * telemetry — whether *our capture* finished refining — not an
       * observation about what the picture contains.
       */
      settled: boolean;
      elapsedMs: number;
      attempt: number;
    }
  | {
      kind: "view-failed";
      slot: ViewSlot;
      failure: RenderFailure;
      attempt: number;
      /** True when the session has automatically re-queued this direction. */
      willRetry: boolean;
    }
  | { kind: "session-closed"; reason: SessionCloseReason };

export type SessionCloseReason =
  /** Every direction reached a terminal state. */
  | "complete"
  /** The caller aborted (superseded search, unmount, StrictMode double-invoke). */
  | "aborted"
  /** A failure that would repeat for every remaining direction. */
  | "fatal";

/** A live render session. Closing it destroys the WebGL context. */
export interface RenderSession {
  events: AsyncIterable<CaptureEvent>;
  /**
   * Re-capture one direction inside the still-open session.
   *
   * Costs **zero** new billable requests: "Timed session tokens allow for up to
   * three hours of renderer tile requests from a single root tileset request"
   * (Map Tiles usage & billing, read 2026-08-05). Resolves with the resulting
   * `view-captured` or `view-failed` event, which is also emitted on `events`.
   */
  recapture(slot: ViewSlot): Promise<CaptureEvent>;
  /** False once the WebGL context is gone; `recapture` is unavailable then. */
  readonly isOpen: boolean;
  close(): void;
}

/** Per-slot UI phase. */
/**
 * Per-direction UI phase.
 *
 * `no-window` is not a stage of loading and never becomes one: the facade is
 * shared with the building next door, so nothing was requested for it and
 * nothing will arrive. It is separate from `failed` because nothing failed, and
 * separate from `queued` because a queued direction is one the app is still
 * working on. See DirectionConfidence.insideNeighborByM.
 */
export type SlotPhase =
  | "queued"
  | "capturing"
  | "ready"
  | "failed"
  | "no-window";
