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
  RenderState,
  ViewPlan,
  ViewSlot,
} from "../lib/types";
import type { DirectionClass } from "../lib/directionClass";
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
 *
 * The enclosure measurement and the settle state are independent facts and are
 * reported as such: the first is about the world, the second is about our own
 * capture loop, and a slow settle does not make a neighbouring building any
 * further away. When both hold they share one sentence, obstruction first,
 * because the obstruction is the fact the reader came for.
 */
export function directionNote(
  confidence: DirectionConfidence | undefined,
  opts: {
    settled?: boolean;
    capturable?: boolean;
    /**
     * The imagery for this direction did not arrive. Adds a sentence; it never
     * replaces one. See the composition below.
     */
    didNotLoad?: boolean;
  } = {},
): string | null {
  // A DIRECTION THAT DID NOT LOAD KEEPS WHAT WAS MEASURED ABOUT IT. The
  // obstruction is a fact about the building and is exactly as true when the
  // frame is missing. Announcing only the missing frame spends the one line
  // available on the renderer and throws away the answer the reader came for —
  // the same mistake the settle state used to make, arrived at from the other
  // side. Both are said, the measurement first, because the measurement is the
  // part that is about the building.
  // A direction with no frame has no settle state to report either: `settled`
  // describes the capture that produced a picture, and there is no picture.
  // Dropping it here rather than trusting every caller keeps the two sentences
  // from ever being three.
  const measured = measuredNote(confidence, {
    ...opts,
    settled: opts.didNotLoad ? undefined : opts.settled,
  });
  if (!opts.didNotLoad) return measured;
  return measured === null ? NO_IMAGERY_NOTE : `${measured} ${NO_IMAGERY_NOTE}`;
}

/** What is true of the direction itself, independent of whether it rendered. */
function measuredNote(
  confidence: DirectionConfidence | undefined,
  opts: { settled?: boolean; capturable?: boolean },
): string | null {
  if (confidence?.insideNeighborByM != null) return ABUTTING_NOTE;
  if (confidence?.courtWidthM != null) {
    return opts.capturable === false
      ? narrowCourtNote(confidence.courtWidthM)
      : courtNote(confidence.courtWidthM);
  }

  const enclosure = confidence ? enclosureClause(confidence) : null;
  if (opts.settled === false) {
    return enclosure === null
      ? STILL_SHARPENING_NOTE
      : `${enclosure}${STILL_SHARPENING_CLAUSE}`;
  }
  return enclosure === null ? null : `${enclosure}.`;
}

/**
 * What the footprint arithmetic establishes about one direction's enclosure, as
 * a clause with no terminal punctuation, or null when the direction is open.
 *
 * Unpunctuated so the caller can end it, or continue it with the settle clause,
 * without taking a sentence apart again.
 */
function enclosureClause(confidence: DirectionConfidence): string | null {
  switch (confidence.band) {
    case "enclosed":
      if (
        confidence.firstBlockingM !== null &&
        confidence.firstBlockingM < ENCLOSED_MAX_FIRST_BLOCKING_M
      ) {
        return `Another building stands about ${Math.round(
          confidence.firstBlockingM,
        )} m from this side`;
      }
      return "This side looks into nearby buildings rather than out over the city";
    case "partly-enclosed":
      return "Partly enclosed — nearby rooftops fill much of this direction";
    case "open":
      return null;
  }
}

/**
 * Copy for a capture that ended on the hard timeout rather than on the quiet
 * period, when there is nothing else to say about the direction.
 */
const STILL_SHARPENING_NOTE = "Still sharpening when this frame was captured.";

/**
 * The same fact appended to an enclosure clause. Shorter than the standalone
 * sentence because it has to fit behind the longest of them and stay inside the
 * one-short-sentence budget the whole set is held to.
 */
const STILL_SHARPENING_CLAUSE = "; this frame was still sharpening.";

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
export function qualityLead(quality: DirectionClass): string | null {
  switch (quality) {
    case "close":
      return "Close range";
    case "qualified":
      return "Enclosed";
    case "no-window":
      return "No window on this side";
    case "no-room":
      return "Too narrow to capture";
    case "unmeasured":
      // Said per direction as well as once at the head of the result, because
      // the head note is easy to scroll past and this is the difference between
      // "measured, and there is nothing in the way" and "not measured". An open
      // view and an unchecked one must not read the same.
      return "Surroundings not checked";
    case "open":
      return null;
  }
}

/**
 * What the app is doing about one direction, in words, inside the frame.
 *
 * The empty frame is a transparent 4:3 box with a hairline border, which is the
 * correct rendering of "no imagery here" and a poor rendering of "no imagery
 * here YET". For up to about forty seconds the first time, a reader saw a large
 * blank rectangle with nothing said in it, which is indistinguishable from a
 * picture that failed to decode. These are the words that go in it.
 *
 * They are states, not progress: no percentage, no fraction, no ETA. The
 * capture ends on either a quiet period or a hard deadline and neither is a
 * fraction of a known total, so there is no honest bar to draw.
 */
export function renderStateLabel(
  state: RenderState,
  cls: DirectionClass,
): string | null {
  switch (state) {
    case "queued":
      return "Waiting to capture";
    case "capturing":
      return "Capturing";
    case "failed":
      return "Didn't load";
    case "not-requested":
      return cls === "no-room" ? "No frame on this side" : "No window";
    case "ready":
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
    if (loadedCount === 0 && stillCapturing) {
      // The first frame of a session takes tens of seconds, and until this line
      // existed the result said nothing at all about it: four empty frames, a
      // plan drawing, and no statement that anything was happening. It is a
      // count of completed work against a known denominator — the number of
      // directions actually asked for — and it is the only progress claim the
      // app can make honestly.
      notes.push({
        id: "capturing",
        text: capturingNote(totalCount),
      });
    } else if (loadedCount > 0 && loadedCount < totalCount) {
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
 * Copy for a session that is running and has produced nothing yet.
 *
 * States the denominator, because the denominator is known and is not always
 * four — a building with a party wall has fewer directions to capture, and
 * saying "four" there would be wrong. States no numerator, because zero of four
 * reads as a failure rather than as a beginning, and no ETA, because the app
 * does not have one.
 */
function capturingNote(total: number): string {
  return total === 1
    ? "Capturing this direction now. Each one appears as it arrives."
    : `Capturing ${total} directions now. Each one appears as it arrives.`;
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
