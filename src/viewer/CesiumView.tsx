import type { CameraView } from "../lib/types";
import { useTileCaptures } from "./useTileCaptures";

interface CesiumViewProps {
  view: CameraView;
  /** True when no imagery key is configured — render nothing (no fake scene). */
  disabled?: boolean;
}

/**
 * A single view frame.
 *
 * - `disabled` (no imagery key): shows an empty labeled frame with a truthful
 *   note. It never draws a placeholder or simulated scene.
 * - enabled: shows the static PNG captured from the shared Cesium 3D-tile
 *   session for this slot (see useTileCaptures). The capture IS real
 *   photogrammetric imagery from Google Photorealistic 3D Tiles, with Google's
 *   per-frame data attribution composited along its bottom edge.
 */
export function CesiumView({ view, disabled }: CesiumViewProps) {
  const captures = useTileCaptures(disabled);
  const state = captures.state;

  if (disabled) {
    return (
      <div className="view__canvas" aria-hidden="true" />
    );
  }

  if (state === "error") {
    return (
      <div className="view__canvas" role="img" aria-label="Imagery unavailable">
        <NoticeOverlay text={captures.errorMsg ?? "Imagery didn't load for this view."} />
      </div>
    );
  }

  if (state === "loading" || state === "idle") {
    return (
      <div className="view__canvas" role="img" aria-label="Rendering view">
        <NoticeOverlay text="Rendering…" spinner />
      </div>
    );
  }

  const dataUrl = captures.bySlot[view.slot];
  if (!dataUrl) {
    return (
      <div className="view__canvas" role="img" aria-label="Imagery unavailable">
        <NoticeOverlay text="No imagery for this direction." />
      </div>
    );
  }

  return (
    <img
      className="view__canvas"
      src={dataUrl}
      alt={`Approximately the view facing ${view.compass} (${Math.round(
        view.headingDeg,
      )} degrees) from this floor`}
      loading="lazy"
    />
  );
}

function NoticeOverlay({ text, spinner }: { text: string; spinner?: boolean }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "grid",
        placeContent: "center",
        gap: "0.6rem",
        color: "var(--text-faint)",
        fontSize: "0.82rem",
        textAlign: "center",
        padding: "1rem",
      }}
    >
      {spinner && <span className="spinner" style={{ margin: "0 auto" }} />}
      <span>{text}</span>
    </div>
  );
}
