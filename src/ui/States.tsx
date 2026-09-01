// The honest non-result states.
//
// Every one of these is a *message*, never a picture: when real data is
// missing the app says so, and no code path substitutes a placeholder,
// block-model, or simulated scene. The not-supported state is first-class —
// it is the answer most free-text addresses will get, by design.

import type { CuratedBuilding, UnavailableReason } from "../lib/types";

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="state state-loading" role="status">
      <p>{label}</p>
    </div>
  );
}

/** No imagery key configured: everything up to the render works; the render
 *  honestly does not. */
export function NoImagerySourceState() {
  return (
    <div className="state" role="status">
      <h2>Imagery source not configured</h2>
      <p>
        The address and camera geometry resolved, but no Google Map Tiles API
        key is configured, so there is no real imagery to show. 27B never
        substitutes a synthetic scene. Set{" "}
        <code>VITE_GOOGLE_MAPS_KEY</code> to enable the renderer.
      </p>
    </div>
  );
}

export function UnavailableState({
  reason,
  message,
  supportedFloors,
  curatedBuildings,
}: {
  reason: UnavailableReason;
  message: string;
  supportedFloors?: { min: number; max: number };
  /** Fetched from the backend (GET /api/curated-buildings) by App.tsx --
   *  see lib/api.ts. */
  curatedBuildings: CuratedBuilding[];
}) {
  if (reason === "not-supported") {
    return (
      <div className="state" role="status">
        <h2>We don't have a good view for this one yet</h2>
        <p>{message}</p>
        {!supportedFloors && (
          <>
            <p>
              The 3D imagery this app renders is only photographic where the
              sightlines are long (tall buildings, or buildings facing a park
              or river). At a typical mid-block address the source mesh isn't
              good enough, so it says so instead of showing a bad frame.
            </p>
            <p className="state-list-label">Buildings with verified views:</p>
            <ul className="state-list">
              {curatedBuildings.map((b) => (
                <li key={b.bin}>
                  {b.name}, floors {b.floors.min}-{b.floors.max}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }

  const heading =
    reason === "not-nyc"
      ? "Outside New York City"
      : reason === "network-error"
        ? "A data service is unreachable"
        : "Not available for this address yet";
  return (
    <div className="state" role="status">
      <h2>{heading}</h2>
      <p>{message}</p>
    </div>
  );
}
