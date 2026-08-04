import { CARDINAL_LABEL } from "../lib/types";
import type { ViewPlan } from "../lib/types";
import { CesiumView } from "../viewer/CesiumView";
import { TileCapturesProvider } from "../viewer/useTileCaptures";
import { SaveViews } from "./SaveViews";

interface ResultViewProps {
  result: { ok: true; plan: ViewPlan; fromCache: boolean };
  /** When true, render is suppressed (no imagery key) — labels/frames only. */
  renderDisabled?: boolean;
}

/**
 * Presents a produced ViewPlan: the resolved address + geometry summary, then
 * the four building-relative cardinal views. Each view either mounts a CesiumJS
 * render (when a key is configured) or an empty labeled frame (no key) — never a
 * placeholder scene.
 */
export function ResultView({ result, renderDisabled }: ResultViewProps) {
  const { plan, fromCache } = result;

  return (
    <section className="result" aria-label="Building views">
      <div className="result__head">
        <div>
          <h2 className="result__addr">{plan.geocode.label}</h2>
          <p className="result__meta">
            floor {plan.floor}{plan.floorClampedToRoof && <span className="meta-note"> (clamped — building is shorter)</span>} · eye {plan.eyeElevationM.toFixed(1)} m asl · roof {plan.footprint.roofHeightM.toFixed(1)} m ·{" "}
            <code>BIN {plan.footprint.bin}</code>
          </p>
        </div>
        <div>
          <span className="badge badge--approx">approximately what you'd see</span>{" "}
          {fromCache && <span className="badge badge--cache">from cache</span>}
        </div>
      </div>

      <TileCapturesProvider plan={plan} disabled={renderDisabled}>
        <div className="views">
          {plan.views.map((view) => (
            <figure className="view" key={view.cardinal}>
              <figcaption className="view__label">
                <span className="view__compass">{view.cardinal}</span>
                <span className="view__dir">{CARDINAL_LABEL[view.cardinal]}</span>
                <span className="view__bearing">{view.headingDeg}°</span>
              </figcaption>
              <CesiumView view={view} disabled={renderDisabled} />
            </figure>
          ))}
        </div>
        {!renderDisabled && <SaveViews plan={plan} />}
      </TileCapturesProvider>
    </section>
  );
}
