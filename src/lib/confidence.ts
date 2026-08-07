// How enclosed is each direction? Answered from building geometry alone.
//
// =============================================================================
// WHY THERE IS NO IMAGE ANALYSIS AND NO SCENE PICKING HERE
// =============================================================================
//
// If you are reading this file wondering why it reconstructs obstruction from
// municipal polygons instead of asking the renderer, the answer is that both
// obvious approaches are contractually unavailable to this app. This note
// exists because the better-looking implementation is trivially reachable —
// `scene.pick` is three lines away in an API the app already imports — and
// someone will otherwise "improve" this module into a licence violation.
//
// Google Map Tiles API Policies, quoted verbatim from the page as it stood on
// 2026-07-31 (re-read 2026-08-05):
//
//     "You may not use Map Tiles API for any non-visualization use cases, such
//      as: Image analysis, Machine interpretation, Object detection or
//      identification, Geodata extraction or resale, Offline uses, including
//      for any of the above"
//
//     "You may overlay your own 3D objects on Photorealistic 3D Tiles as long
//      as the 3D objects aren't extracted, traced, or otherwise derived by hand
//      or machine from Photorealistic 3D Tiles."
//
// Google Maps Platform ToS §3.2.3(c), "No Creating Content From Google Maps
// Content" (document last modified 2026-06-23).
//
// Ruled out by those clauses:
//
//   1. Reading back the captured PNG to measure sky fraction, edge density or
//      blur and scoring the frame from it. That is "Image analysis" and
//      "Machine interpretation".
//   2. `scene.pick` / `globe.pick` / `sampleHeight` / any ray cast against the
//      loaded Google mesh to find what occludes the view. That is "Geodata
//      extraction", and any object derived from it is "derived by machine from
//      Photorealistic 3D Tiles". This would produce a *better* answer than what
//      is below. It is still not available.
//   3. Any ML model touching the frames or the mesh — ToS §3.2.3(c)(vii)
//      explicitly covers using the content to "train, test, validate or
//      fine-tune" models. (AI compositing was separately dropped from this
//      project permanently; see README.)
//
// THE ONE BOUNDARY CASE. `settled` — whether our capture loop ended on the
// quiet-period grace or on the hard timeout — is our own client's loading
// telemetry, not an observation about the imagery. The rule this codebase
// encodes: **we may report whether our capture completed; we may never report
// what is in the picture.** Everything in this file is arithmetic over NYC Open
// Data. Nothing here reads a pixel.
//
// =============================================================================
// THE METRIC
// =============================================================================
//
// For each of the four directions independently, over neighbouring footprints
// within `SEARCH_RADIUS_M` of the camera and inside a ±`CONE_HALF_ANGLE_DEG`
// cone about its heading:
//
//     d      = horizontal distance from the camera to a point on a neighbour's
//              outline
//     top    = that neighbour's ground elevation + roof height   (NAVD88)
//     angle  = atan2(top - eyeElevation, d)                      (degrees)
//
//     maxObstructionAngleDeg = max(angle)
//     firstBlockingM         = min(d) over points where angle > 0
//
// Both terms are NAVD88 throughout — the source datum of every input — so the
// GEOID18 conversion the camera needs is irrelevant here. That removes a whole
// class of datum error from the warning path, which is a real benefit and not
// an accident: the confidence layer deliberately never leaves the datum its
// data arrives in.
//
// `maxObstructionAngleDeg` is negative when nothing inside the cone reaches the
// eye line at all. Because `atan2(negative, d)` rises towards 0 as d grows, a
// negative maximum is set by the tallest neighbour measured at the far edge of
// the search radius; read it as "the closest anything in this direction comes
// to your eye level", not as a bearing to a specific building.
//
// SAMPLING. Edges are sampled at `EDGE_SAMPLE_STEP_M`, plus the exact point of
// closest approach to the camera when it falls inside the segment and the cone.
// Sampling *vertices only* would miss a long wall whose endpoints fall outside
// the cone while its middle crosses it — precisely the case of a slab building
// broadside to the view. `confidence.test.ts` pins that case.

import type {
  CameraView,
  ConfidenceReport,
  DirectionConfidence,
  EnclosureBand,
  NeighborBuilding,
  ViewSlot,
} from "./types";
import { ringToLocalMeters, pointInRingMeters } from "./geometry";
import { RENDER_TUNING } from "../viewer/renderTuning";

/**
 * Horizontal search radius, metres.
 *
 * 220 m is far enough that a Midtown block face and the one behind it are both
 * inside it, and near enough that the SoQL query stays sub-second and well
 * under 200 KB even in the densest part of Manhattan (measured 2026-08-05:
 * 202 rows / 161,876 bytes / 1.27 s around the Empire State Building).
 */
export const SEARCH_RADIUS_M = 220;

/**
 * Half-angle of the view cone, degrees.
 *
 * This is now derived from the renderer's actual horizontal field of view
 * rather than approximating it. The previous comment here asked for exactly
 * that, "once a live render is authorized and the real horizontal FOV can be
 * measured" — it has been. Measured 2026-08-06 from a live Cesium session:
 * `PerspectiveFrustum.fov` applies to the wider viewport dimension, so at a
 * 4:3 capture the horizontal field of view *is* `fov`. The renderer ships
 * `RENDER_TUNING.fovDeg = 75`, so the cone is ±37.5°.
 *
 * The two must stay in step: if the cone is narrower than the frame, the notes
 * under a direction can say "open" about a frame that visibly contains a wall.
 * `confidence.test.ts` pins the relationship. The import is type-only at
 * runtime cost of nothing — `RENDER_TUNING` is a plain object in a module this
 * one does not otherwise depend on, and pulling the number across is cheaper
 * than letting the two drift.
 */
export const CONE_HALF_ANGLE_DEG = RENDER_TUNING.fovDeg / 2;

/**
 * How far below an abutting building's roof the eye must sit before we call a
 * direction windowless, metres.
 *
 * Not zero, because two independent source errors point the same way: footprint
 * polygons on a shared lot line can overlap by a metre or so, and `HEIGHTROOF`
 * is a single number for a building with parapets and bulkheads. A camera a
 * few centimetres under a neighbour's nominal roofline is a measurement
 * artefact; one two metres under it is inside the building next door.
 */
export const ABUTTING_MIN_DEPTH_M = 2;

/** Spacing for sampling along a footprint edge, metres. */
export const EDGE_SAMPLE_STEP_M = 2;

/**
 * Band thresholds.
 *
 * ==> HONEST PROVENANCE, DO NOT LAUNDER THIS <==
 *
 * These four numbers were fitted to the SIXTEEN directions in the existing
 * proof package (Empire State Building floors 6 and 80, 425 E 79th St floor 10,
 * Flatiron floor 18), whose visual quality had been described in
 * docs/repair/release-candidate/27b/REPORT.md §7 *before* the metric was run
 * against them. On that set the split is clean: every direction the report
 * called photographic lands in `open`, and every direction it called melted,
 * blurred or unreadable lands in `enclosed`.
 *
 * That is *consistent with* the documented cases. It is **not** validation on
 * unseen data — the calibration set and the motivating set are the same
 * sixteen directions, and no held-out set exists. Treat these as a starting
 * calibration to be re-checked, not as measured thresholds.
 *
 * Known imperfection, stated rather than hidden: 425 E 79th's 119° view was
 * described in that report as the best of its four — a legible facade — and
 * these rules still call it `enclosed`. The rule over-warns there. For this
 * product over-warning is the correct direction to err; under-warning would be
 * a claim the data does not support.
 *
 * The current numbers as re-derived by *this* implementation (which samples
 * edges, where the original probe sampled vertices) are recorded in
 * docs/repair/personal-authorship-sprint/evidence/27b-confidence-calibration.json
 * and asserted in confidence.test.ts against committed real footprints.
 */
export const OPEN_MIN_FIRST_BLOCKING_M = 60;
export const OPEN_MAX_ANGLE_DEG = 20;
export const ENCLOSED_MAX_FIRST_BLOCKING_M = 25;
export const ENCLOSED_MIN_ANGLE_DEG = 35;

const DEG = 180 / Math.PI;

/** Smallest absolute difference between two bearings, degrees. */
export function bearingDeltaDeg(a: number, b: number): number {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

/** Which band a measured pair falls in. */
export function classifyBand(
  maxObstructionAngleDeg: number,
  firstBlockingM: number | null,
): EnclosureBand {
  const nearest = firstBlockingM ?? Infinity;
  if (
    nearest < ENCLOSED_MAX_FIRST_BLOCKING_M ||
    maxObstructionAngleDeg > ENCLOSED_MIN_ANGLE_DEG
  ) {
    return "enclosed";
  }
  if (
    nearest >= OPEN_MIN_FIRST_BLOCKING_M &&
    maxObstructionAngleDeg <= OPEN_MAX_ANGLE_DEG
  ) {
    return "open";
  }
  return "partly-enclosed";
}

export interface ConfidenceInput {
  views: CameraView[];
  /** Eye elevation in the SOURCE datum. Same datum as the neighbour tops. */
  eyeElevationNavd88M: number;
  /** BIN of the subject building, so it never obstructs itself. */
  subjectBin: string;
  /** Fallback when a neighbour record has no ground elevation of its own. */
  subjectGroundElevationNavd88M: number;
  neighbors: NeighborBuilding[];
  /** True when the neighbour query had to skip records lacking a roof height. */
  neighborDataIncomplete: boolean;
}

/**
 * Measure obstruction in each of the four directions. Pure: no network, no
 * renderer, no imagery.
 */
export function assessConfidence(input: ConfidenceInput): ConfidenceReport {
  const bySlot: Partial<Record<ViewSlot, DirectionConfidence>> = {};
  const usable = input.neighbors.filter((n) => n.bin !== input.subjectBin);

  for (const view of input.views) {
    bySlot[view.slot] = assessDirection(view, usable, input);
  }

  return {
    bySlot,
    neighborDataIncomplete: input.neighborDataIncomplete,
    neighborsConsidered: usable.length,
    searchRadiusM: SEARCH_RADIUS_M,
  };
}

/**
 * Directions worth asking the provider for.
 *
 * One predicate, used by both the renderer (which must not open a capture for a
 * direction with no window) and the UI (which must say why the pane is empty).
 * Two callers agreeing by construction is the point; the alternative is a
 * renderer that skips a slot and a UI that shows it as still loading, forever.
 */
export function isRenderableDirection(
  slot: ViewSlot,
  confidence: ConfidenceReport | null | undefined,
): boolean {
  return confidence?.bySlot[slot]?.insideNeighborByM == null;
}

function assessDirection(
  view: CameraView,
  neighbors: NeighborBuilding[],
  input: ConfidenceInput,
): DirectionConfidence {
  const origin = { lat: view.lat, lng: view.lng };
  let maxAngle = -90;
  let firstBlocking: number | null = null;
  let insideNeighborByM: number | null = null;

  for (const n of neighbors) {
    const top =
      (n.groundElevationNavd88M ?? input.subjectGroundElevationNavd88M) +
      n.roofHeightM;
    const rise = top - input.eyeElevationNavd88M;

    const pts = ringToLocalMeters(n.ring, origin);

    // Is the camera *inside* this neighbour's mass? The ring is already local
    // to the camera, so the camera is the origin. Height matters: a camera on
    // the 8th floor over a 4-storey neighbour is above its roof, which is an
    // ordinary NYC vantage, not a fault.
    if (
      rise >= ABUTTING_MIN_DEPTH_M &&
      rise > (insideNeighborByM ?? -Infinity) &&
      pointInRingMeters(pts, 0, 0)
    ) {
      insideNeighborByM = rise;
    }
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];

      // Cheap reject: an edge that lies wholly outside the search square
      // cannot reach inside the search circle. Written as "both endpoints on
      // the same side" rather than "both endpoints far away", because an edge
      // can have both endpoints beyond the radius while passing straight
      // through the middle of it — which is exactly the long-wall case this
      // module has to get right.
      if (
        (a[0] > SEARCH_RADIUS_M && b[0] > SEARCH_RADIUS_M) ||
        (a[0] < -SEARCH_RADIUS_M && b[0] < -SEARCH_RADIUS_M) ||
        (a[1] > SEARCH_RADIUS_M && b[1] > SEARCH_RADIUS_M) ||
        (a[1] < -SEARCH_RADIUS_M && b[1] < -SEARCH_RADIUS_M)
      ) {
        continue;
      }

      for (const [x, y] of sampleEdge(a, b)) {
        const d = Math.hypot(x, y);
        if (d > SEARCH_RADIUS_M || d < 0.5) continue;
        // Compass bearing of the sample from the camera: atan2(east, north).
        const bearing = Math.atan2(x, y) * DEG;
        if (bearingDeltaDeg(bearing, view.headingDeg) > CONE_HALF_ANGLE_DEG) {
          continue;
        }
        const angle = Math.atan2(rise, d) * DEG;
        if (angle > maxAngle) maxAngle = angle;
        if (angle > 0 && (firstBlocking === null || d < firstBlocking)) {
          firstBlocking = d;
        }
      }
    }
  }

  return {
    slot: view.slot,
    band: classifyBand(maxAngle, firstBlocking),
    maxObstructionAngleDeg: maxAngle,
    firstBlockingM: firstBlocking,
    insideNeighborByM,
  };
}

/**
 * Points to test along one footprint edge: both endpoints, regular samples at
 * `EDGE_SAMPLE_STEP_M`, and the point on the segment closest to the camera
 * (which is at the local origin). The closest-approach point is what makes the
 * maximum angle accurate rather than accurate-to-within-a-sample-step, and it
 * is where a long wall broadside to the view actually blocks it.
 */
function sampleEdge(
  a: [number, number],
  b: [number, number],
): Array<[number, number]> {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const len = Math.hypot(ex, ey);
  const out: Array<[number, number]> = [a];
  if (len < 1e-6) return out;

  const steps = Math.min(Math.ceil(len / EDGE_SAMPLE_STEP_M), 256);
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    out.push([a[0] + ex * t, a[1] + ey * t]);
  }

  // Perpendicular foot from the camera (origin) onto the segment.
  const t = Math.max(0, Math.min(1, -(a[0] * ex + a[1] * ey) / (len * len)));
  out.push([a[0] + ex * t, a[1] + ey * t]);
  return out;
}
