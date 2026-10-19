// The result: up to four real frames, each labelled with the true compass
// bearing its window faces, plus the disclosures that keep the result honest.
//
// Copy rule (non-negotiable): everything here is "approximately what you'd
// see", never "your actual view". The floor height is an estimate, the
// camera stands just outside the facade rather than at a window pane, and the
// mesh is Google's photogrammetry, not a photograph taken today.
//
// Captions are kept to "NNE · 29°": what "facade" vs. "true" bearing means is
// explained once, in the footer below, not repeated on every frame.

import type { ViewPlan, ViewSlot, ViewState } from "../lib/types";

interface Props {
  plan: ViewPlan;
  /** Renderer state per slot, in plan order. */
  states: Record<ViewSlot, ViewState>;
}

export interface RenderProgress {
  /** Views with a final outcome (ready or failed). */
  done: number;
  failed: number;
  total: number;
  /** Status line, or null once every view rendered (nothing left to say). */
  label: string | null;
}

/** How far the render session has got, counted over the plan's views. A
 *  failed view counts as done (it won't change) and is called out, never
 *  folded into the rendered count. */
export function renderProgress(
  slots: readonly ViewSlot[],
  states: Record<ViewSlot, ViewState>,
): RenderProgress {
  const total = slots.length;
  let ready = 0;
  let failed = 0;
  for (const slot of slots) {
    const kind = states[slot]?.kind;
    if (kind === "ready") ready++;
    else if (kind === "failed") failed++;
  }
  const done = ready + failed;
  const failedNote = failed > 0 ? ` · ${failed} didn't load` : "";
  let label: string | null;
  if (done < total) {
    label = `Rendering… ${ready} of ${total} views ready${failedNote}`;
  } else if (failed > 0) {
    label = `${ready} of ${total} views rendered${failedNote}`;
  } else {
    label = null;
  }
  return { done, failed, total, label };
}

function ProgressLine({ progress }: { progress: RenderProgress }) {
  const { done, total, label } = progress;
  // The live region stays mounted (empty when finished) so screen readers
  // reliably announce each change.
  return (
    <div className="render-progress" role="status" aria-live="polite">
      {label && (
        <>
          <p>{label}</p>
          {done < total && (
            <div className="render-progress-track" aria-hidden="true">
              <div
                className="render-progress-fill"
                style={{ width: `${(done / total) * 100}%` }}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function frameCaption(plan: ViewPlan, slot: ViewSlot): string {
  const view = plan.views.find((v) => v.slot === slot);
  if (!view) return "";
  return `${view.compass} · ${Math.round(view.headingDeg)}°`;
}

function Frame({ plan, slot, state }: { plan: ViewPlan; slot: ViewSlot; state: ViewState }) {
  return (
    <figure className="frame">
      {state.kind === "ready" ? (
        <img
          src={state.result.dataUrl}
          alt={`Rendered 3D view ${frameCaption(plan, slot)} from floor ${plan.floor} of ${plan.curatedName}`}
        />
      ) : (
        <div
          className={`frame-empty frame-${state.kind}`}
          role={state.kind === "failed" ? "alert" : "status"}
        >
          {state.kind === "capturing" && <p>Rendering…</p>}
          {state.kind === "pending" && <p>Waiting…</p>}
          {state.kind === "failed" && (
            <p>
              This direction didn't load. Nothing is shown rather than a
              substitute image.
            </p>
          )}
        </div>
      )}
      <figcaption>{frameCaption(plan, slot)}</figcaption>
    </figure>
  );
}

export function ResultView({ plan, states }: Props) {
  return (
    <section className="result" aria-label="Rendered views">
      <header className="result-head">
        <h2>
          {plan.curatedName}, floor {plan.floor}
        </h2>
        <p className="result-sub">{plan.geocode.label}</p>
        <ProgressLine
          progress={renderProgress(
            plan.views.map((v) => v.slot),
            states,
          )}
        />
      </header>

      <div className="frames">
        {plan.views.map((v) => (
          <Frame key={v.slot} plan={plan} slot={v.slot} state={states[v.slot]} />
        ))}
      </div>

      <footer className="result-notes">
        <p>
          This is <strong>approximately what you'd see</strong> from this floor,
          not your actual view. Floor height is an estimate (3.2 m per floor,
          eye 1.5 m above the slab{plan.floorClampedToRoof ? ", clamped to the real roof height" : ""}),
          and the camera stands just outside the building's{" "}
          {plan.basis === "facade"
            ? "own facades"
            : "footprint on true compass bearings (this footprint has no dominant facade direction)"}
          .
        </p>
        <p>
          Imagery is Google's photorealistic 3D reconstruction of New York,
          rendered live and shipped as captured, with no generative or
          synthetic step. Attribution is baked into each frame.
        </p>
      </footer>
    </section>
  );
}
