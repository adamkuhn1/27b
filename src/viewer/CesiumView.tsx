import type { CameraView } from "../lib/types";
import { useTileCaptures } from "./useTileCaptures";
import { ABUTTING_NOTE, NARROW_COURT_REASON } from "../ui/notes";

/**
 * Where the frame is being shown.
 *
 * `lead` is the large view; `thumb` is one cell of the direction strip. They
 * differ ONLY in class names and in whether the frame carries its own
 * description — a thumbnail sits inside a button that is already labelled, so
 * describing it again would announce every direction twice.
 *
 * They deliberately do not differ in anything else. This component is the only
 * place in the app that can put an `<img>` on screen (pinned by
 * antiFabrication.test.ts), and the reason that invariant is worth having is
 * that every rule about what may appear in a frame lives in one function. A
 * second img tag elsewhere for "just the thumbnails" would be exactly the edit
 * that quietly reintroduces a placeholder.
 */
export type ViewSize = "lead" | "thumb";

interface CesiumViewProps {
  view: CameraView;
  /** True when no imagery key is configured — render nothing (no fake scene). */
  disabled?: boolean;
  /**
   * Why this direction was never requested, when it wasn't.
   *
   * `no-window`: the facade is inside the building next door at this height.
   * `no-room`: it faces a light court too narrow to stand a camera in.
   *
   * Either way nothing was asked for and nothing will arrive, so the frame is
   * empty on purpose and the label says which. A wider light court IS captured,
   * from inside the court, and does not come through here. See
   * lib/confidence.ts.
   */
  uncaptured?: "no-window" | "no-room";
  size?: ViewSize;
}

const CLASSES: Record<ViewSize, { image: string; empty: string }> = {
  lead: { image: "view__canvas", empty: "view__canvas view__canvas--empty" },
  thumb: { image: "thumb__img", empty: "thumb__empty" },
};

/**
 * A single view frame.
 *
 * There are exactly two things this component can put inside the frame: a real
 * capture, or nothing. `queued`, `capturing`, `failed` and the no-key case all
 * render an empty frame — no placeholder, no gradient, no silhouette, no
 * "representative" image. The frame keeps its label and bearing throughout,
 * because the geometry for that direction is real and known even when the
 * imagery is not.
 *
 * The capture itself IS real photogrammetric imagery from Google Photorealistic
 * 3D Tiles, with Google's per-frame data attribution composited along its
 * bottom edge.
 */
export function CesiumView({
  view,
  disabled,
  uncaptured,
  size = "lead",
}: CesiumViewProps) {
  const captures = useTileCaptures(disabled);
  const cls = CLASSES[size];
  const decorative = size === "thumb";

  /** An empty frame, described unless something else already describes it. */
  const empty = (label: string | null) =>
    decorative || label === null ? (
      <div className={cls.empty} aria-hidden="true" />
    ) : (
      <div className={cls.empty} role="img" aria-label={label} />
    );

  if (disabled) return empty(null);

  if (uncaptured === "no-window") {
    return empty(`No window facing ${view.compass}. ${ABUTTING_NOTE}`);
  }
  if (uncaptured === "no-room") {
    return empty(
      `No frame facing ${view.compass}. ${NARROW_COURT_REASON}`,
    );
  }

  const slot = captures.bySlot[view.slot];

  if (captures.phase === "failed" || slot?.phase === "failed") {
    return empty(`Imagery unavailable facing ${view.compass}`);
  }

  if (!slot || slot.phase === "queued" || slot.phase === "capturing") {
    const label =
      slot?.phase === "capturing"
        ? `Capturing the view facing ${view.compass}`
        : `Waiting to capture the view facing ${view.compass}`;
    return decorative ? (
      <div className={cls.empty} aria-hidden="true" />
    ) : (
      <div
        className={cls.empty}
        role="img"
        aria-label={label}
        data-capturing={slot?.phase === "capturing" ? "true" : undefined}
      />
    );
  }

  if (!slot.dataUrl) {
    // Defensive: "ready" without pixels is not a state this app can produce,
    // and if it ever does, an empty frame is the only honest rendering of it.
    return empty(null);
  }

  return (
    <img
      className={cls.image}
      src={slot.dataUrl}
      alt={
        decorative
          ? ""
          : `Approximately the view facing ${view.compass} (${Math.round(
              view.headingDeg,
            )} degrees) from this floor`
      }
      loading="lazy"
    />
  );
}
