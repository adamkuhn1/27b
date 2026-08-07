import type { CameraView } from "../lib/types";
import { useTileCaptures } from "./useTileCaptures";
import { ABUTTING_NOTE } from "../ui/notes";

interface CesiumViewProps {
  view: CameraView;
  /** True when no imagery key is configured — render nothing (no fake scene). */
  disabled?: boolean;
  /**
   * True when this facade faces the building next door at this height. Nothing
   * was requested for it and nothing will arrive; the pane is empty on purpose
   * and the label says why.
   *
   * Deliberately NOT phrased as "a shared wall". The predicate behind this flag
   * tests whether the camera, placed FACADE_OFFSET_M beyond the wall, lands
   * inside a neighbour that rises above the eye — which is not the same thing,
   * and was asserted as plain fact about a building where it is false. See the
   * note at ui/notes.ts:ABUTTING_NOTE.
   */
  noWindow?: boolean;
}

/**
 * A single view frame.
 *
 * There are exactly two things this component can put inside the frame: a real
 * capture, or nothing. `queued`, `capturing`, `failed` and the no-key case all
 * render an empty pane — no placeholder, no gradient, no silhouette, no
 * "representative" image. The pane keeps its label and bearing throughout,
 * because the geometry for that direction is real and known even when the
 * imagery is not.
 *
 * The capture itself IS real photogrammetric imagery from Google Photorealistic
 * 3D Tiles, with Google's per-frame data attribution composited along its
 * bottom edge.
 */
export function CesiumView({ view, disabled, noWindow }: CesiumViewProps) {
  const captures = useTileCaptures(disabled);

  if (disabled) {
    return <div className="view__canvas view__canvas--empty" aria-hidden="true" />;
  }

  if (noWindow) {
    return (
      <div
        className="view__canvas view__canvas--empty"
        role="img"
        aria-label={`No window facing ${view.compass}. ${ABUTTING_NOTE}`}
      />
    );
  }

  const slot = captures.bySlot[view.slot];

  if (captures.phase === "failed" || slot?.phase === "failed") {
    return (
      <div
        className="view__canvas view__canvas--empty"
        role="img"
        aria-label={`Imagery unavailable facing ${view.compass}`}
      />
    );
  }

  if (!slot || slot.phase === "queued" || slot.phase === "capturing") {
    return (
      <div
        className="view__canvas view__canvas--empty"
        role="img"
        aria-label={
          slot?.phase === "capturing"
            ? `Capturing the view facing ${view.compass}`
            : `Waiting to capture the view facing ${view.compass}`
        }
        data-capturing={slot?.phase === "capturing" ? "true" : undefined}
      />
    );
  }

  if (!slot.dataUrl) {
    // Defensive: "ready" without pixels is not a state this app can produce,
    // and if it ever does, an empty pane is the only honest rendering of it.
    return <div className="view__canvas view__canvas--empty" aria-hidden="true" />;
  }

  return (
    <img
      className="view__canvas"
      src={slot.dataUrl}
      alt={`Approximately the view facing ${view.compass} (${Math.round(
        view.headingDeg,
      )} degrees) from this floor`}
      loading="lazy"
    />
  );
}
