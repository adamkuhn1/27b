import type { CameraView, ConfidenceReport, ViewPlan, ViewSlot } from "../lib/types";
import { isDirectionRequested } from "../lib/directionClass";

// Which direction the result opens on, and in which order the four are asked
// for.
//
// The result shows ONE view large and the rest as thumbnails, so something has
// to choose which one you see first. It is decided from geometry alone, before
// any imagery exists, and it never changes as frames arrive. Re-ranking on
// arrival would reshuffle the page under the reader's hands, and — worse — the
// only signal available at that point would be which frames loaded, which is a
// fact about the network rather than about the building.
//
// Nothing here reads a pixel. See the header of `lib/confidence.ts`.

/**
 * Ranking of the enclosure bands, best first. An open direction is the one a
 * person opening this page wants to see; the qualified ones are the ones they
 * want to be warned about, which is a different job and belongs on the label.
 */
const BAND_RANK: Record<string, number> = {
  open: 0,
  "partly-enclosed": 1,
  enclosed: 2,
};

/** Sorts after every band, because it is the most qualified case there is. */
const COURT_RANK = 3;

function rank(
  slot: ViewSlot,
  confidence: ConfidenceReport | null | undefined,
): number {
  const d = confidence?.bySlot[slot];
  // No enclosure data at all is not a bad direction, it is an unmeasured one.
  // Ranking it worst would hand the lead to a measured-enclosed direction on
  // the strength of an absence, so it sits between open and partly-enclosed.
  if (!d) return 0.5;
  // A camera standing in a light court is looking at the wall opposite from a
  // couple of metres. Whatever its band works out to, it is not the frame to
  // open on.
  if (d.courtWidthM != null) return COURT_RANK;
  return BAND_RANK[d.band] ?? 2;
}

/**
 * The direction to show large, or `null` when the building has none to show.
 *
 * Ties break on the distance to the nearest thing that rises above the eye —
 * further is more open — and then on the plan's own slot order, so the choice
 * is deterministic for a given building and floor.
 */
export function chooseLeadDirection(plan: ViewPlan): ViewSlot | null {
  return captureOrder(plan)[0]?.slot ?? null;
}

/**
 * The directions to ask the provider for, best first.
 *
 * The same ranking that picks the lead, applied to all of them, so the order
 * frames are requested in matches the order the reader cares about them. The
 * direction shown large is therefore the first one captured and the first one
 * to appear, rather than whichever slot sorts first alphabetically — which is
 * what left a large empty frame on screen while the three thumbnails beside it
 * filled in.
 *
 * This changes nothing about any camera: the bearings, standoffs and heights
 * are already fixed by the geometry pipeline before this runs, and the ranking
 * reads the same footprint arithmetic the lead choice has always read. It is
 * settled once, from geometry, before any imagery exists, and never revisited
 * as frames arrive.
 *
 * `Array.prototype.sort` is stable in every engine this ships to (required by
 * the spec since ES2019), so equal-ranked directions keep plan order.
 */
export function captureOrder(plan: ViewPlan): CameraView[] {
  return plan.views
    .filter((v) => isDirectionRequested(v.slot, plan.confidence))
    .map((view, index) => ({ view, index }))
    .sort((a, b) => {
      const byRank =
        rank(a.view.slot, plan.confidence) - rank(b.view.slot, plan.confidence);
      if (byRank !== 0) return byRank;
      // Subtracting these would produce NaN when both are unbounded, and a NaN
      // comparator leaves the order up to the engine.
      const oa = openness(a.view.slot, plan.confidence);
      const ob = openness(b.view.slot, plan.confidence);
      if (oa !== ob) return ob > oa ? 1 : -1;
      return a.index - b.index;
    })
    .map((entry) => entry.view);
}

/** Distance to the nearest obstruction above the eye; unbounded when there is none. */
function openness(
  slot: ViewSlot,
  confidence: ConfidenceReport | null | undefined,
): number {
  return confidence?.bySlot[slot]?.firstBlockingM ?? Infinity;
}

// How a direction is presented — `open`, `qualified`, `close`, `no-room`,
// `no-window`, `unmeasured` — is not decided here either. It is one function in
// `lib/directionClass.ts`, reading the footprint arithmetic and nothing else,
// and both this file's ranking and the renderer's request list are derived from
// it.
