import type { ViewPlan } from "../lib/types";
import { CesiumView } from "../viewer/CesiumView";
import { TileCapturesProvider, useTileCaptures } from "../viewer/useTileCaptures";

interface ResultViewProps {
  result: { ok: true; plan: ViewPlan; fromCache: boolean };
  /** When true, render is suppressed (no imagery key) — labels/frames only. */
  renderDisabled?: boolean;
}

/**
 * Presents a produced ViewPlan: the resolved address + geometry summary, then
 * the four views. Each view either mounts a real Google Photorealistic 3D Tiles
 * capture (when a key is configured) or an empty labeled frame (no key) — never
 * a placeholder scene.
 */
export function ResultView({ result, renderDisabled }: ResultViewProps) {
  const { plan, fromCache } = result;
  const aboveGroundM =
    plan.eyeElevationNavd88M - plan.footprint.groundElevationNavd88M;

  return (
    <section className="result" aria-label="Building views">
      <div className="result__head">
        <div>
          <h2 className="result__addr">{plan.geocode.label}</h2>
          <p className="result__meta">
            floor {plan.floor}
            {plan.floorClampedToRoof && (
              <span className="meta-note"> (clamped — building is shorter)</span>
            )}{" "}
            · eye {aboveGroundM.toFixed(1)} m above ground · roof{" "}
            {plan.footprint.roofHeightM.toFixed(1)} m ·{" "}
            <code>BIN {plan.footprint.bin}</code>
          </p>
          <p className="result__meta result__meta--dim">
            {plan.basis === "facade"
              ? "Views look out along this building's own facades (from its footprint), so the bearings are not N/E/S/W."
              : "This footprint has no dominant facade orientation, so these are true compass views."}{" "}
            Camera height {plan.eyeElevationNavd88M.toFixed(1)} m NAVD88 ={" "}
            {plan.eyeElevationEllipsoidalM.toFixed(1)} m WGS84 ellipsoidal
            (geoid {plan.geoidHeightM.toFixed(1)} m).
          </p>
        </div>
        <div>
          <span className="badge badge--approx">approximately what you'd see</span>{" "}
          {fromCache && <span className="badge badge--cache">geometry from cache</span>}
        </div>
      </div>

      <TileCapturesProvider plan={plan} disabled={renderDisabled}>
        <div className="views">
          {plan.views.map((view) => (
            <figure className="view" key={view.slot}>
              <figcaption className="view__label">
                <span className="view__compass">{view.compass}</span>
                <span className="view__dir">
                  {plan.basis === "facade" ? "facade view" : "compass view"}
                </span>
                <span className="view__bearing">
                  {view.headingDeg.toFixed(0)}° true
                </span>
              </figcaption>
              <CesiumView view={view} disabled={renderDisabled} />
            </figure>
          ))}
        </div>
        {!renderDisabled && <ImageryAttribution />}
      </TileCapturesProvider>
    </section>
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
 * https://developers.google.com/maps/documentation/tile/policies
 */
function ImageryAttribution() {
  const captures = useTileCaptures();
  if (captures.state !== "ready") return null;
  return (
    <p className="attribution">
      Imagery: <strong>Google Maps</strong>
      {captures.attribution ? ` · ${captures.attribution}` : ""}
    </p>
  );
}
