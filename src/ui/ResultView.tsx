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
