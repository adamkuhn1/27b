// What the geometry establishes about one direction, and nothing else.
//
// =============================================================================
// WHY THIS IS A MODULE OF ITS OWN
// =============================================================================
//
// Two different questions used to be answered by one predicate:
//
//   1. WHAT IS THIS SIDE OF THE BUILDING? A party wall, a light court too narrow
//      to stand in, a wide court, an enclosed outlook, an open one. This is
//      arithmetic over NYC Open Data footprints. It is the same answer every
//      time for a given building and floor, and it is true whether or not any
//      imagery is ever requested.
//
//   2. IS THERE ANYTHING TO ASK THE PROVIDER FOR? A render-side question, and
//      the only correct source for its answer is question 1.
//
// Answering 2 first and deriving 1 from it — which is what the old
// `isRenderableDirection` / `viewQuality` pair did, `viewQuality` calling the
// renderer's predicate to decide between `close` and `no-room` — makes the
// classification a consequence of a render decision rather than the cause of
// one. Here the arrow runs one way only: `classifyDirection` reads geometry,
// `isCaptureRequested` reads the class, and nothing reads back.
//
// =============================================================================
// AN ABSENT MEASUREMENT IS NOT AN OPEN VIEW
// =============================================================================
//
// The neighbour lookup is best-effort: `planView` gives it a bounded window and
// ships the plan without it when the open-data service is slow (see
// `NEIGHBOR_TIMEOUT_MS`). The plan then carries `confidence: null`.
//
// The classification that used to be produced from that absence was `normal` —
// the identical value a direction gets when the neighbours WERE measured and
// nothing stands in the way. So the same address at the same floor was
// classified one way on a fast open-data response and another way on a slow
// one, and a facade the arithmetic would have called `no-window` was presented
// as an ordinary view with an ordinary frame. That is a classification moving
// with the clock, which it must never do.
//
// `unmeasured` exists so the absence has a name. It is not `open`, it is not
// `qualified`, and it is never one of the four measured classes. The four
// measured classes can only be produced by a completed measurement, so no
// timing can invent one or take one away; the only thing timing can change is
// whether there is a measurement at all, and that fact is now stated rather
// than hidden inside a value that means something else.
//
// Nothing in this file reads a pixel, and nothing in it knows a render exists.

import type { ConfidenceReport, ViewSlot } from "./types";
import { courtStandoffM } from "./confidence";

/**
 * How a direction should be presented, from geometry alone.
 *
 * - `open` — measured, and nothing needs saying about it.
 * - `qualified` — measured as enclosed: the outlook is into nearby buildings.
 * - `close` — a light court wide enough to hold a camera. The frame is a
 *   close-range view of the wall opposite, and is announced as one before it is
 *   looked at, because an unannounced close-range frame reads as a broken
 *   render rather than as the answer.
 * - `no-room` — a light court too narrow to hold a camera at all.
 * - `no-window` — the facade is inside the building next door at this height.
 * - `unmeasured` — the neighbour data never arrived. See the header.
 */
export type DirectionClass =
  | "open"
  | "qualified"
  | "close"
  | "no-room"
  | "no-window"
  | "unmeasured";

/** The classes that only a completed neighbour measurement can produce. */
export const MEASURED_CLASSES: readonly DirectionClass[] = [
  "open",
  "qualified",
  "close",
  "no-room",
  "no-window",
] as const;

/**
 * Classify one direction from the enclosure report.
 *
 * Pure, total, and a function of the report alone: no render state, no elapsed
 * time, no imagery. Given the same `ConfidenceReport` this returns the same
 * class forever.
 */
export function classifyDirection(
  slot: ViewSlot,
  confidence: ConfidenceReport | null | undefined,
): DirectionClass {
  if (!confidence) return "unmeasured";
  const d = confidence.bySlot[slot];
  // A report that exists but has no row for this slot is the same absence as no
  // report at all — the direction was not measured.
  if (!d) return "unmeasured";
  if (d.insideNeighborByM != null) return "no-window";
  if (d.courtWidthM != null) {
    return courtStandoffM(d.courtWidthM) === null ? "no-room" : "close";
  }
  return d.band === "enclosed" ? "qualified" : "open";
}

/**
 * Whether the renderer should open a capture for a direction of this class.
 *
 * Derived from the class and from nothing else, so the renderer and the UI
 * cannot disagree about which directions were asked for. A facade with no
 * window, and a court with no room to stand in, have nothing to photograph: the
 * provider would return the interior of a neighbouring mesh, which is the
 * melted-grey-landscape failure this project must never present as a view.
 *
 * `unmeasured` IS requested. Not knowing what is on that side is not a reason
 * to refuse to look at it, and the result states that the surroundings could
 * not be checked.
 */
export function isCaptureRequested(cls: DirectionClass): boolean {
  return cls !== "no-window" && cls !== "no-room";
}

/** Convenience for the common `classify then ask` pair. */
export function isDirectionRequested(
  slot: ViewSlot,
  confidence: ConfidenceReport | null | undefined,
): boolean {
  return isCaptureRequested(classifyDirection(slot, confidence));
}
