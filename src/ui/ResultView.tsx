import type { CameraView, SlotPhase, ViewPlan, ViewSlot } from "../lib/types";
import { CesiumView } from "../viewer/CesiumView";
import {
  TileCapturesProvider,
  readyCount,
  useTileCaptures,
} from "../viewer/useTileCaptures";
import { PlanDiagram } from "./PlanDiagram";
import {
  NO_IMAGERY_NOTE,
  RENDER_ALL_AGAIN,
  RETRY_THIS_DIRECTION,
  confidenceFor,
  directionNote,
  planNotes,
} from "./notes";

interface ResultViewProps {
  result: { ok: true; plan: ViewPlan; fromCache: boolean };
  /** When true, render is suppressed (no imagery key) — labels/frames only. */
  renderDisabled?: boolean;
  /** Re-run the whole lookup. Costs one root tileset request. */
  onRenderAgain?: () => void;
}

/**
 * Presents a produced ViewPlan as a plan drawing plus four elevations.
 *
 * The structure is on screen — correctly labelled, with real bearings — from
 * the moment the geometry resolves, roughly a second in. Imagery lands into it
 * as each direction is captured. A direction that never loads keeps its label,
 * its bearing and its arrow on the plan, and shows an empty frame; it is never
 * filled with a substitute.
 */
export function ResultView({
  result,
  renderDisabled,
  onRenderAgain,
}: ResultViewProps) {
  const { plan } = result;

  return (
    <section className="result" aria-label="Building views">
      <TileCapturesProvider plan={plan} disabled={renderDisabled}>
        <ResultBody plan={plan} onRenderAgain={onRenderAgain} />
      </TileCapturesProvider>
    </section>
  );
}

function ResultBody({
  plan,
  onRenderAgain,
}: {
  plan: ViewPlan;
  onRenderAgain?: () => void;
}) {
  const captures = useTileCaptures();
  const loaded = readyCount(captures.bySlot);
  const aboveGroundM =
    plan.eyeElevationNavd88M - plan.footprint.groundElevationNavd88M;

  const notes = planNotes(plan, {
    loadedCount: loaded,
    totalCount: plan.views.length,
    imageryUnavailable: captures.phase === "failed",
  });

  const phaseBySlot: Partial<Record<ViewSlot, SlotPhase>> = {};
  for (const view of plan.views) {
    phaseBySlot[view.slot] = captures.bySlot[view.slot]?.phase ?? "queued";
  }

  return (
    <>
      <header className="result__head">
        <h2 className="result__addr">{plan.geocode.label}</h2>
        {/* The approximate/exact distinction, said plainly and kept in view. */}
        <p className="result__frame">
          Approximate view · floor {plan.floor}
        </p>
        <p className="result__sub">
          Where a window on this side would be — not a specific apartment.
        </p>
      </header>

      {notes.length > 0 && (
        <ul className="notes" aria-label="About this result">
          {notes.map((n) => (
            <li key={n.id}>{n.text}</li>
          ))}
        </ul>
      )}

      <div className="result__drawings">
        <PlanDiagram plan={plan} phaseBySlot={phaseBySlot} />

        <div className="views">
          {plan.views.map((view) => (
            <ViewPane key={view.slot} plan={plan} view={view} />
          ))}
        </div>
      </div>

      <details className="disclosure">
        <summary>How this was placed</summary>
        <p className="result__meta result__meta--dim">
          Eye {aboveGroundM.toFixed(1)} m above ground · roof{" "}
          {plan.footprint.roofHeightM.toFixed(1)} m ·{" "}
          <code>BIN {plan.footprint.bin}</code> · footprint rectangularity{" "}
          {plan.facadeConcentration.toFixed(2)}
        </p>
        <p className="result__meta result__meta--dim">
          {plan.basis === "facade"
            ? "Views look out along this building's own facades (from its footprint), so the bearings are not N/E/S/W."
            : "This footprint has no dominant facade orientation, so these are true compass views."}{" "}
          Camera height {plan.eyeElevationNavd88M.toFixed(1)} m NAVD88 ={" "}
          {plan.eyeElevationEllipsoidalM.toFixed(1)} m WGS84 ellipsoidal (geoid{" "}
          {plan.geoidHeightM.toFixed(1)} m).
        </p>
        {plan.confidence && (
          <p className="result__meta result__meta--dim">
            Enclosure notes computed from {plan.confidence.neighborsConsidered}{" "}
            neighbouring footprints within {plan.confidence.searchRadiusM} m
            (NYC Open Data). No imagery is analysed.
          </p>
        )}
      </details>

      {captures.phase !== "idle" && (
        <ImageryAttribution onRenderAgain={onRenderAgain} />
      )}
    </>
  );
}

function ViewPane({ plan, view }: { plan: ViewPlan; view: CameraView }) {
  const captures = useTileCaptures();
  const slot = captures.bySlot[view.slot];
  const sessionFailed = captures.phase === "failed";
  const failed = slot?.phase === "failed" || sessionFailed;
  // When the whole session failed, the reason is stated once at the head
  // instead of four identical times under four empty frames.
  const note = failed
    ? sessionFailed
      ? null
      : NO_IMAGERY_NOTE
    : directionNote(confidenceFor(plan.confidence, view.slot), {
        settled: slot?.phase === "ready" ? slot.settled : undefined,
      });

  return (
    <figure className="view" data-phase={failed ? "failed" : slot?.phase ?? "queued"}>
      <figcaption className="view__label">
        <span className="view__compass">{view.compass}</span>
        <span className="view__bearing">{view.headingDeg.toFixed(0)}° true</span>
      </figcaption>
      <CesiumView view={view} disabled={captures.phase === "idle"} />
      {note && <p className="view__note">{note}</p>}
      {/*
        Offered only while the session is open, because that is the only time
        it is free. Once the session closes, re-capturing one direction costs
        exactly as much as re-capturing four, and the honest offer is the
        whole-result button under the attribution line instead.

        Be clear about how narrow that window is. A direction is re-queued
        automatically once, at the back, so a single failing direction usually
        reaches its terminal state as the last item in the queue — and the
        session closes immediately after. This button therefore appears mainly
        when TWO directions have trouble, which is also when it is worth the
        most. Widening the window would mean holding the WebGL context open
        idle after a result, which was considered and declined.
      */}
      {failed && captures.sessionOpen && (
        <button
          type="button"
          className="view__retry"
          onClick={() => captures.retrySlot(view.slot)}
        >
          {RETRY_THIS_DIRECTION}
        </button>
      )}
    </figure>
  );
}

/**
 * Google Maps attribution for the imagery on screen.
 *
 * Required by the Map Tiles API policies: the Google Maps logo (or, where space
 * is limited, the words "Google Maps") plus the aggregated per-tile data
 * attributions, displayed with the imagery. Each captured frame also carries the
 * same line composited into its own pixels, so the credit survives even if a
 * frame is viewed on its own.
 *
 * Rendered from whatever has actually landed, recomputed on each arrival — so
 * it is correct for what is on screen at any moment, not only at the end.
 * https://developers.google.com/maps/documentation/tile/policies
 */
function ImageryAttribution({ onRenderAgain }: { onRenderAgain?: () => void }) {
  const captures = useTileCaptures();
  const loaded = readyCount(captures.bySlot);

  // A session that closed with a direction still missing is the only case where
  // re-rendering is the honest offer: once the session is gone, re-capturing one
  // direction costs exactly as much as re-capturing all four, so the UI never
  // pretends otherwise.
  const missing =
    !captures.sessionOpen &&
    captures.phase !== "running" &&
    captures.phase !== "idle" &&
    loaded < Object.keys(captures.bySlot).length;

  if (loaded === 0 && !missing) return null;

  return (
    <div className="attribution">
      {loaded > 0 && (
        <p className="attribution__line">
          Imagery: <strong>Google Maps</strong>
          {captures.attribution ? ` · ${captures.attribution}` : ""}
        </p>
      )}
      {missing && onRenderAgain && (
        <button type="button" className="btn btn--quiet" onClick={onRenderAgain}>
          {RENDER_ALL_AGAIN}
        </button>
      )}
    </div>
  );
}
