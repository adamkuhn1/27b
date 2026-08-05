import type { UnavailableReason } from "../lib/types";

/** Loading indicator shown while the geometry pipeline runs. */
export function LoadingState() {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      Geocoding address · resolving building footprint · computing camera geometry…
    </div>
  );
}

const REASON_TITLE: Record<UnavailableReason, string> = {
  "not-nyc": "Address isn't in New York City",
  "geocode-failed": "Address not found",
  "no-footprint": "Building footprint not available",
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
    </section>
  );
}

/**
 * Shown when the geometry resolved but no imagery source is configured
 * (VITE_GOOGLE_MAPS_KEY unset — see the README for how to set one). Truthful
 * about *why* there's no render, and deliberately NOT a placeholder scene. The
 * setup instructions for an operator live in the README, not here.
 */
export function NoImagerySourceState() {
  return (
    <section className="state">
      <h2 className="state__title">Imagery source not configured</h2>
      <p className="state__body">
        The building geometry above is real. This copy of the app doesn't have
        an imagery source connected, so the four views are shown as empty
        frames rather than a placeholder scene.
      </p>
    </section>
  );
}
