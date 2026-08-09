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
  opts: { settled?: boolean; capturable?: boolean } = {},
): string | null {
  if (confidence?.insideNeighborByM != null) return ABUTTING_NOTE;
  if (confidence?.courtWidthM != null) {
    return opts.capturable === false
      ? narrowCourtNote(confidence.courtWidthM)
      : courtNote(confidence.courtWidthM);
  }
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
 * Copy for a wall that is inside the building next door.
 *
 * Deliberately about the building, not about us: nothing failed and nothing is
 * missing.
 *
 * The predicate now tests the WALL rather than the camera six metres beyond it,
 * so this string is finally saying what the measurement establishes. The older,
 * looser test also caught every facade across a light court narrower than the
 * camera offset — a real window with a real close view — and the note said
 * "faces the building next door" about them. At 425 E 79th St that suppressed
 * the ESE facade across a measured 4.4 m court. Those directions now get
 * `courtNote` and a camera placed inside the court instead.
 */
export const ABUTTING_NOTE =
  "At this height this side faces the building next door.";

/**
 * The same fact as `narrowCourtNote`, without the measurement, for the places
 * that describe the empty frame itself rather than annotate it — the frame's
 * accessible name, which already names the direction.
 */
export const NARROW_COURT_REASON =
  "The light court on this side is too narrow to place a camera in.";

/**
 * Copy for a facade across a light court or narrow side lot.
 *
 * Both clauses are measurements from NYC Open Data footprints, not observations
 * about the frame. The width is rounded to the metre because the underlying
 * polygons are not surveyed to better than that.
 */
export function courtNote(courtWidthM: number): string {
  return `A light court ${courtWidth(courtWidthM)} — the building opposite is very close.`;
}

/**
 * Copy for a light court too narrow to stand a camera in.
 *
 * The same measurement as `courtNote`, and a different fact about it: below
 * about three metres there is no position that clears both walls, so this
 * direction is never requested and the frame beside this sentence is empty
 * because of the building, not because something failed.
 */
export function narrowCourtNote(courtWidthM: number): string {
  return `A light court ${courtWidth(
    courtWidthM,
  )} — too narrow to place a camera in, so this side has no frame.`;
}

/**
 * Widths are rounded to the metre because the underlying polygons are not
 * surveyed to better than that. Rounding a 40 cm gap to "about 0 m wide" is the
 * one case where that is worse than saying it in words.
 */
function courtWidth(courtWidthM: number): string {
  const rounded = Math.round(courtWidthM);
  return rounded < 1 ? "under a metre wide" : `about ${rounded} m wide`;
}

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

/**
 * The one-line qualification shown beside a direction's label, or null.
 *
 * Said BEFORE the picture rather than under it. A close-range frame that
 * arrives unannounced reads as a broken render; the same frame introduced as a
 * light court reads as the answer. `directionNote` still carries the
 * measurement itself — this is only the heading over it.
 */
export function qualityLead(
  quality: "normal" | "qualified" | "close" | "no-window" | "no-room",
): string | null {
  switch (quality) {
    case "close":
      return "Close range";
    case "qualified":
      return "Enclosed";
    case "no-window":
      return "No window on this side";
    case "no-room":
      return "Too narrow to capture";
    case "normal":
      return null;
  }
}

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
    /**
     * Whether frames are still arriving. Three-way, and the third value
     * matters: `undefined` means there is no render to report on — no imagery
     * key — and a count note would then be describing something that was never
     * requested.
     */
    stillCapturing?: boolean;
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

  const { loadedCount, totalCount, stillCapturing } = opts;
  if (loadedCount !== undefined && totalCount !== undefined && totalCount > 0) {
    if (loadedCount > 0 && loadedCount < totalCount) {
      notes.push({
        id: "partial",
        text:
          stillCapturing === false
            ? partialNote(loadedCount, totalCount)
            : `${loadedCount} of ${totalCount} directions loaded.`,
      });
    } else if (
      loadedCount === 0 &&
      stillCapturing === false &&
      !opts.imageryUnavailable
    ) {
      // The session opened and then produced nothing. Indistinguishable from
      // the outside from a session that never opened, and it gets the same
      // sentence — the guarantee it states is the one the reader needs.
      notes.push({ id: "none-loaded", text: NO_IMAGERY_AT_ALL_NOTE });
    }
  }

  return notes;
}

/**
 * Copy for a render that finished with some directions still missing.
 *
 * The bare count this replaces ("2 of 4 directions loaded.") left two empty
 * frames on screen with nothing said about them, which reads as a broken
 * renderer. It is the count PLUS the guarantee: those frames are empty because
 * nothing arrived, not because something was put in their place. Which
 * directions they are is marked on the frames themselves and on the plan.
 */
function partialNote(loaded: number, total: number): string {
  const missing = total - loaded;
  return missing === 1
    ? `${loaded} of ${total} directions loaded; the other frame is empty, not a stand-in.`
    : `${loaded} of ${total} directions loaded; the other ${missing} frames are empty, not stand-ins.`;
}

/** Look up one direction's measurement, if the report exists. */
export function confidenceFor(
  report: ConfidenceReport | null,
  slot: ViewSlot,
): DirectionConfidence | undefined {
  return report?.bySlot[slot];
}
