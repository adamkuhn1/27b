import type { ConfidenceReport, ViewPlan, ViewSlot } from "../lib/types";
import { isRenderableDirection } from "../lib/confidence";

// Which direction the result opens on.
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
  const candidates = plan.views.filter((v) =>
    isRenderableDirection(v.slot, plan.confidence),
  );
  if (candidates.length === 0) return null;

  let best = candidates[0];
  let bestRank = rank(best.slot, plan.confidence);
  let bestOpenness = openness(best.slot, plan.confidence);

  for (const view of candidates.slice(1)) {
    const r = rank(view.slot, plan.confidence);
    const o = openness(view.slot, plan.confidence);
    if (r < bestRank || (r === bestRank && o > bestOpenness)) {
      best = view;
      bestRank = r;
      bestOpenness = o;
    }
  }
  return best.slot;
}

/** Distance to the nearest obstruction above the eye; unbounded when there is none. */
function openness(
  slot: ViewSlot,
  confidence: ConfidenceReport | null | undefined,
): number {
  return confidence?.bySlot[slot]?.firstBlockingM ?? Infinity;
}

/**
 * How a direction should be presented, given what was measured about it.
 *
 * `close` exists so a frame taken from two metres off the wall opposite is
 * labelled as one before it is looked at, rather than read as an ordinary view
 * that came out badly. That distinction is the difference between a limitation
 * and a defect, and only the app knows which this is.
 */
export type ViewQuality = "normal" | "qualified" | "close" | "no-window";

export function viewQuality(
  slot: ViewSlot,
  confidence: ConfidenceReport | null | undefined,
): ViewQuality {
  const d = confidence?.bySlot[slot];
  if (!d) return "normal";
  if (d.insideNeighborByM != null) return "no-window";
  if (d.courtWidthM != null) return "close";
  if (d.band === "enclosed") return "qualified";
  return "normal";
}
