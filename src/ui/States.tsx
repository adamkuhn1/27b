import type { UnavailableReason } from "../lib/types";

/** Loading indicator shown while the geometry pipeline runs. */
export function LoadingState() {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      Resolving address, building height, and camera geometry…
    </div>
  );
}

const REASON_TITLE: Record<UnavailableReason, string> = {
  "not-nyc": "That address isn't in New York City",
  "geocode-failed": "We couldn't find that address",
  "no-footprint": "Not available for this address yet",
  "network-error": "Something went wrong",
};

/**
 * The honest "not available" state. This is the ONLY thing shown when real data
 * is missing — there is no fabricated fallback scene, by design. Every failure
 * reason from the pipeline routes here.
 */
export function UnavailableState({
  reason,
  message,
}: {
  reason: UnavailableReason;
  message: string;
}) {
  return (
    <section className="state" role="status" aria-live="polite">
      <h2 className="state__title">{REASON_TITLE[reason]}</h2>
      <p className="state__body">{message}</p>
      <p className="state__body">
        27B only shows a view when it can source real geometry for the exact
        building. When it can't, it says so — it never substitutes a made-up
        scene.
      </p>
    </section>
  );
}

/**
 * Shown when the geometry resolved but no imagery source is configured
 * (VITE_GOOGLE_MAPS_KEY unset). Truthful about *why* there's no render, and
 * deliberately NOT a placeholder scene.
 */
export function NoImagerySourceState() {
  return (
    <section className="state state--placeholder">
      <h2 className="state__title">Imagery source not configured</h2>
      <p className="state__body">
        The building geometry below is real and resolved. The photorealistic
        render is gated behind an imagery key that isn't set in this environment,
        so the four views can't be drawn here.
      </p>
      <p className="state__body">
        Set <code>VITE_GOOGLE_MAPS_KEY</code> (Google Map Tiles API) to enable
        the CesiumJS render. See <code>.env.example</code>. This state is shown
        instead of a placeholder scene on purpose — 27B never fabricates imagery.
      </p>
    </section>
  );
}
