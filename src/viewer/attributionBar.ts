// Layout for the attribution bar baked into every captured frame.
//
// Separate from `tileRenderer.ts` for the same reason `renderTuning.ts` is:
// that module imports Cesium, and importing Cesium is the most expensive thing
// this app can do. The rules here — how large the text is and where it wraps —
// are arithmetic, and keeping them out of the engine module is what lets them
// be proven in a Node unit test instead of asserted about as source text.
//
// WHY THE SIZE IS A FRACTION OF THE FRAME
//
// Google's Map Tiles API policies require the attributions for displayed tiles
// to be shown, in full, with the imagery. 27B bakes them into the frame's own
// pixels so the credit cannot be separated from the picture by, say, saving the
// image on its own.
//
// The bar was previously a flat 12 px on an 800 px-wide capture. Nothing ever
// cropped it — but the frame is scaled down to fit its pane on screen, and the
// text scales with it. In the four-up grid the panes measured 247-513 CSS px,
// so 12 source pixels landed as 3.7-7.7 device pixels at DPR 1: present,
// uncropped, and unreadable. The same constant also ignored `superSample`, so
// raising the backing store made the credit line smaller relative to the image.
//
// Both are the same mistake — a constant tied to the source raster rather than
// to the picture. The frame width already includes `superSample` (Cesium's
// `resolutionScale` multiplies the backing store, and the capture reads the
// backing store), so deriving from it fixes the supersampling case as well.

/**
 * Bar text height as a fraction of frame width. 0.015 is 12 px at the 800 px
 * baseline — the size the bar has always rendered at — so this changes how the
 * size is *derived* without changing the baseline capture's appearance.
 */
export const BAR_TEXT_FRACTION = 0.015;

/**
 * Floor on the text size, px. A capture small enough to drive the fraction
 * below this is already too small to display a legible credit, and shrinking
 * the type further would only make the bar look intentional.
 */
export const BAR_MIN_FONT_PX = 11;

export interface BarLayout {
  fontPx: number;
  /** Left/right inset, and (halved) the gap above the first line. */
  padPx: number;
  lineHeightPx: number;
  /** The credit text, wrapped. Never truncated. */
  lines: string[];
  /** Total bar height in frame pixels. */
  heightPx: number;
}

/**
 * Text size and padding for a frame of a given width.
 *
 * Exported separately from `layoutAttributionBar` so the compositor can build
 * its `font` string and measure with it before wrapping.
 */
export function barMetrics(frameWidthPx: number): {
  fontPx: number;
  padPx: number;
  lineHeightPx: number;
} {
  const fontPx = Math.max(
    BAR_MIN_FONT_PX,
    Math.round(frameWidthPx * BAR_TEXT_FRACTION),
  );
  return {
    fontPx,
    padPx: Math.round(fontPx * 0.67),
    lineHeightPx: Math.round(fontPx * 1.25),
  };
}

/**
 * Wrap the credit line to the frame width and report the bar's height.
 *
 * `measureWidth` is injected so this is testable without a canvas; the
 * compositor passes a 2D context's `measureText`.
 *
 * The text is never truncated. The policy asks for the attributions in full, so
 * when they do not fit on one line the IMAGE GROWS — which is why the captured
 * PNG is 800x623 or 800x638 rather than 800x600, and why the stylesheet must
 * not force a 4:3 aspect ratio onto it.
 *
 * A single word longer than the available width still gets its own line rather
 * than being broken or dropped: an over-wide line is a legibility problem, a
 * dropped one is a compliance problem.
 */
export function layoutAttributionBar(
  frameWidthPx: number,
  text: string,
  measureWidth: (s: string) => number,
): BarLayout {
  const { fontPx, padPx, lineHeightPx } = barMetrics(frameWidthPx);
  const maxWidth = frameWidthPx - padPx * 2;

  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    const next = current ? `${current} ${word}` : word;
    if (measureWidth(next) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);

  return {
    fontPx,
    padPx,
    lineHeightPx,
    lines,
    heightPx: lines.length * lineHeightPx + padPx,
  };
}
