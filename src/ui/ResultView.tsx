import { useEffect, useState } from "react";
import type { CameraView, SlotPhase, ViewPlan, ViewSlot } from "../lib/types";
import { isRenderableDirection } from "../lib/confidence";
import { CesiumView } from "../viewer/CesiumView";
import {
  TileCapturesProvider,
  readyCount,
  useTileCaptures,
} from "../viewer/useTileCaptures";
import { PlanDiagram } from "./PlanDiagram";
import { chooseLeadDirection, viewQuality } from "./leadDirection";
import {
  NO_IMAGERY_NOTE,
  RENDER_ALL_AGAIN,
  RETRY_THIS_DIRECTION,
  confidenceFor,
  directionNote,
  planNotes,
  qualityLead,
} from "./notes";

interface ResultViewProps {
  result: { ok: true; plan: ViewPlan; fromCache: boolean };
  /** When true, render is suppressed (no imagery key) — labels/frames only. */
  renderDisabled?: boolean;
  /** Re-run the whole lookup. Costs one root tileset request. */
  onRenderAgain?: () => void;
}

/**
 * Presents a produced ViewPlan as one large view, the other directions beside
 * it, and a plan drawing showing which way each looks.
 *
 * ONE LARGE VIEW, NOT FOUR SMALL ONES. Four panes in a grid gave every
 * direction 338 CSS px of an 800 px capture — small enough that the picture
 * could not be read and the baked attribution line came out at 3.7-7.7 device
 * pixels. It also made the page a specimen sheet: four thumbnails of a building
 * you were considering living in, all equally unreadable. The four directions
 * are still all here and still all captured; one of them is simply the size a
 * photograph should be.
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

  // Which direction opens the result, chosen from geometry before any imagery
  // exists (see leadDirection.ts). Held in state so the reader can change it,
  // and re-seeded only when the plan itself changes — never when a frame lands.
  const [selected, setSelected] = useState<ViewSlot | null>(() =>
    chooseLeadDirection(plan),
  );
  useEffect(() => setSelected(chooseLeadDirection(plan)), [plan]);

  // The denominator is the number of directions we ASKED the provider for, not
  // the number of facades. A wall shared with the building next door was never
  // requested, and counting it here would report "3 of 4 directions loaded" —
  // which reads as one having failed when nothing did.
  const requested = plan.views.filter((v) =>
    isRenderableDirection(v.slot, plan.confidence),
  ).length;

  const notes = planNotes(plan, {
    loadedCount: loaded,
    totalCount: requested,
    imageryUnavailable: captures.phase === "failed",
  });

  const phaseBySlot: Partial<Record<ViewSlot, SlotPhase>> = {};
  for (const view of plan.views) {
    phaseBySlot[view.slot] = isRenderableDirection(view.slot, plan.confidence)
      ? captures.bySlot[view.slot]?.phase ?? "queued"
      : "no-window";
  }

  const leadView =
    plan.views.find((v) => v.slot === selected) ?? plan.views[0] ?? null;

  return (
    <>
      <header className="result__head">
        <h2 className="result__addr">{plan.geocode.label}</h2>
        <p className="result__frame">
          Floor {plan.floor} · approximate view, not a specific apartment
        </p>
      </header>

      {notes.length > 0 && (
        <ul className="notes" aria-label="About this result">
          {notes.map((n) => (
            <li key={n.id}>{n.text}</li>
          ))}
        </ul>
      )}

      <div className="result__stage">
        {leadView && <LeadView plan={plan} view={leadView} />}

        <aside className="result__aside">
          <PlanDiagram plan={plan} phaseBySlot={phaseBySlot} />
        </aside>
      </div>

      <DirectionStrip
        plan={plan}
        selected={leadView?.slot ?? null}
        onSelect={setSelected}
      />

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

/**
 * The direction shown large.
 *
 * `data-quality` carries what the geometry established about this direction, so
 * a frame taken from two metres off the wall opposite is announced as one
 * BEFORE it is looked at. A close-range frame that arrives unlabelled reads as
 * a broken render; the same frame under "a light court about 4 m wide" reads as
 * the answer to the question. The app knows which it is, so it says so.
 */
function LeadView({ plan, view }: { plan: ViewPlan; view: CameraView }) {
  const captures = useTileCaptures();
  const slot = captures.bySlot[view.slot];
  const quality = viewQuality(view.slot, plan.confidence);
  const noWindow = quality === "no-window";
  const sessionFailed = captures.phase === "failed";
  const failed = !noWindow && (slot?.phase === "failed" || sessionFailed);
  const lead = qualityLead(quality);

  const note = failed
    ? sessionFailed
      ? null
      : NO_IMAGERY_NOTE
    : directionNote(confidenceFor(plan.confidence, view.slot), {
        settled: slot?.phase === "ready" ? slot.settled : undefined,
      });

  return (
    <figure
      className="lead"
      data-quality={quality}
      data-phase={
        noWindow ? "no-window" : failed ? "failed" : slot?.phase ?? "queued"
      }
    >
      <figcaption className="lead__caption">
        <span className="lead__compass">Looking {view.compass}</span>
        <span className="lead__bearing">
          {view.headingDeg.toFixed(0)}° true
        </span>
        {lead && <span className="lead__quality">{lead}</span>}
      </figcaption>

      <CesiumView view={view} disabled={captures.phase === "idle"} noWindow={noWindow} />

      {note && <p className="lead__note">{note}</p>}

      {/*
        Offered only while the session is open, because that is the only time it
        is free. Once the session closes, re-capturing one direction costs
        exactly as much as re-capturing four, and the honest offer is the
        whole-result button under the attribution line instead.
      */}
      {failed && captures.sessionOpen && (
        <button
          type="button"
          className="lead__retry"
          onClick={() => captures.retrySlot(view.slot)}
        >
          {RETRY_THIS_DIRECTION}
        </button>
      )}
    </figure>
  );
}

/**
 * The other directions, as a row of small frames you can promote.
 *
 * All four are always listed, in plan order, including the one currently shown
 * large. Showing only the other three would have saved a slot and cost the
 * reader a stable row: with three of four rotating through four positions,
 * every click moves every remaining thumbnail. A fixed row with the current one
 * marked is the switcher people already know how to use.
 */
function DirectionStrip({
  plan,
  selected,
  onSelect,
}: {
  plan: ViewPlan;
  selected: ViewSlot | null;
  onSelect: (slot: ViewSlot) => void;
}) {
  const captures = useTileCaptures();

  return (
    <div className="thumbs" role="group" aria-label="The four directions">
      {plan.views.map((view) => {
        const quality = viewQuality(view.slot, plan.confidence);
        const noWindow = quality === "no-window";
        const isSelected = view.slot === selected;

        return (
          <button
            key={view.slot}
            type="button"
            className="thumb"
            data-quality={quality}
            data-selected={isSelected ? "true" : undefined}
            aria-pressed={isSelected}
            // A direction with no window has nothing to promote: there is no
            // frame and there never will be one. It stays in the row, labelled,
            // because it is still one of the building's four sides.
            disabled={noWindow}
            onClick={() => onSelect(view.slot)}
          >
            <span className="thumb__frame">
              <CesiumView
                view={view}
                disabled={captures.phase === "idle"}
                noWindow={noWindow}
                size="thumb"
              />
            </span>
            <span className="thumb__label">
              <span className="thumb__compass">{view.compass}</span>
              {noWindow && <span className="thumb__state">no window</span>}
              {quality === "close" && <span className="thumb__state">close range</span>}
            </span>
          </button>
        );
      })}
    </div>
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
