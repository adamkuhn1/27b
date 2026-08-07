// Every sentence 27B says about the limits of a result, in one file.
//
// They live together so they can be reviewed as a set rather than discovered
// one at a time across four components. Three rules govern all of them:
//
//   1. **Every string is entailed by a number the app computed.** No note is
//      ever shown "just in case". If there is no measurement, there is no note.
//   2. **Nothing here reads a pixel.** The enclosure notes come from NYC Open
//      Data footprint arithmetic (lib/confidence.ts); the "still sharpening"
//      note is about our own capture loop, not about the image.
//   3. **Visitor vocabulary only.** No provider clause numbers, no datum names,
//      no BIN, no NAVD88, no percentages, no ETA. Those facts are real and stay
//      available in the "How this was placed" disclosure — they are just not in
//      the primary reading path.
//
// Strings that must never appear anywhere in this app, because each would be a
// claim the data does not support: "your view", "your actual view", "the view
// from apartment 27B", "obstruction detected", "quality: low", any percentage,
// any ETA, and any word implying the image itself was examined.

import type {
  ConfidenceReport,
  DirectionConfidence,
  ViewPlan,
  ViewSlot,
} from "../lib/types";
import { ENCLOSED_MAX_FIRST_BLOCKING_M } from "../lib/confidence";

/** Eye height below which you are looking across the street, not over the city. */
export const LOW_VANTAGE_M = 12;

/** Below this, four bearings are a loose fit to the building's walls. */
export const LOOSE_FACADE_CONCENTRATION = 0.8;

/**
 * The note shown under one direction, or null for silence.
 *
 * Silence is the default. An open view gets no note at all — a line of
 * reassurance under every frame would be noise, and would make the frames that
 * genuinely need a warning harder to notice.
 */
export function directionNote(
  confidence: DirectionConfidence | undefined,
  opts: { settled?: boolean } = {},
): string | null {
  if (confidence?.insideNeighborByM != null) return ABUTTING_NOTE;
  if (opts.settled === false) return "Still sharpening when this frame was captured.";
  if (!confidence) return null;

  switch (confidence.band) {
    case "enclosed":
      if (
        confidence.firstBlockingM !== null &&
        confidence.firstBlockingM < ENCLOSED_MAX_FIRST_BLOCKING_M
      ) {
        return `Another building stands about ${Math.round(
          confidence.firstBlockingM,
        )} m from this side.`;
      }
      return "This side looks into nearby buildings rather than out over the city.";
    case "partly-enclosed":
      return "Partly enclosed — nearby rooftops fill much of this direction.";
    case "open":
      return null;
  }
}

/**
 * Copy for a wall that is shared with the building next door.
 *
 * Deliberately about the building, not about us: nothing failed and nothing is
 * missing.
 *
 * The wording states what the test actually establishes, and no more. The
 * predicate asks whether the camera — placed FACADE_OFFSET_M beyond the wall —
 * lands inside a neighbour that rises above the eye. That is not the same as a
 * shared wall, and an earlier version of this string said it was: at
 * 425 E 79th St the flagged side has a measured 4.4 m gap to its neighbour, so
 * "this wall is shared with the building next door" was asserted as plain fact
 * about a building where it is false.
 *
 * KNOWN LIMITATION, deliberately not papered over by the rewording: because the
 * predicate keys on the offset camera rather than on ring-to-ring adjacency, a
 * direction across a light court or side lot narrower than the offset is
 * suppressed even though a real window there has a real (close) view. Fixing
 * that means measuring subject ring to neighbour ring; see the review findings.
 */
export const ABUTTING_NOTE =
  "At this height this side faces the building next door.";

/** Copy for a direction whose imagery did not arrive. */
export const NO_IMAGERY_NOTE = "This direction didn't load.";
/**
 * Copy for a whole render that never started. Said once, at the result head,
 * rather than four identical times under four empty frames — and it states
 * what did NOT happen, because that is the guarantee.
 */
export const NO_IMAGERY_AT_ALL_NOTE =
  "The imagery didn't load. The measurements above are still real; nothing has been put in its place.";
export const RETRY_THIS_DIRECTION = "Retry this direction";
export const RENDER_ALL_AGAIN = "Render all four again";

export interface PlanNote {
  /** Stable key for React and for tests. */
  id: string;
  text: string;
}

/**
 * Notes about the result as a whole. Order is the order they are shown, most
 * consequential first.
 */
export function planNotes(
  plan: ViewPlan,
  opts: {
    loadedCount?: number;
    totalCount?: number;
    /** True when the render session never opened at all. */
    imageryUnavailable?: boolean;
  } = {},
): PlanNote[] {
  const notes: PlanNote[] = [];
  if (opts.imageryUnavailable) {
    notes.push({ id: "no-imagery", text: NO_IMAGERY_AT_ALL_NOTE });
  }
  const aboveGroundM =
    plan.eyeElevationNavd88M - plan.footprint.groundElevationNavd88M;

  if (plan.floorClampedToRoof) {
    notes.push({
      id: "clamped",
      text: `This building is shorter than floor ${plan.floor}. Showing the top floor.`,
    });
  }

  if (aboveGroundM < LOW_VANTAGE_M) {
    notes.push({
      id: "low-vantage",
      text: "At this height you're looking across the street, not over the city.",
    });
  }

  if (plan.basis === "compass") {
    notes.push({
      id: "no-facades",
      text: "This footprint has no clear facades, so these are true north, east, south and west.",
    });
  } else if (plan.facadeConcentration < LOOSE_FACADE_CONCENTRATION) {
    notes.push({
      id: "loose-facades",
      text: "This building isn't a simple rectangle, so these four directions are a best fit to its walls.",
    });
  }

  if (plan.confidence === null) {
    notes.push({
      id: "no-neighbor-data",
      text: "We couldn't check what's around this building, so there are no notes on individual directions.",
    });
  } else if (plan.confidence.neighborDataIncomplete) {
    notes.push({
      id: "incomplete-neighbor-data",
      text: "Some nearby buildings have no height on file, so the notes below may miss an obstruction.",
    });
  }

  const { loadedCount, totalCount } = opts;
  if (
    loadedCount !== undefined &&
    totalCount !== undefined &&
    loadedCount > 0 &&
    loadedCount < totalCount
  ) {
    notes.push({
      id: "partial",
      text: `${loadedCount} of ${totalCount} directions loaded.`,
    });
  }

  return notes;
}

/** Look up one direction's measurement, if the report exists. */
export function confidenceFor(
  report: ConfidenceReport | null,
  slot: ViewSlot,
): DirectionConfidence | undefined {
  return report?.bySlot[slot];
}
