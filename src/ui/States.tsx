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

// "Something went wrong" was the title for every network failure, and on
// 2026-08-08 that is what all five presets showed for hours while NYC
// Planning's GeoSearch returned 503 across every endpoint. It reads as "this
// app is broken", which is both worse than the truth and less useful than it:
// nothing here went wrong, an upstream service was down. Name it.
const REASON_TITLE: Record<UnavailableReason, string> = {
  "not-nyc": "Address isn't in New York City",
  "geocode-failed": "Address not found",
  "no-footprint": "Building footprint not available",
  "network-error": "The NYC address service isn't responding",
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
      {/* Only for the outage case, and only because it is actionable: the
          preset buildings carry a committed record of their coordinates and
          keep working while the lookup service is down (lib/knownAddresses.ts).
          Saying so turns a dead end into the one thing the reader can do. */}
      {reason === "network-error" && (
        <p className="state__body state__body--aside">
          This is geosearch.planninglabs.nyc, the free NYC Planning service every
          address lookup starts at — not this app, and not your connection. The
          buildings offered on the previous screen still work: their coordinates
          are held on file here.
        </p>
      )}
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
