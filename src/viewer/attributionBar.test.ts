import { describe, expect, it } from "vitest";
import {
  BAR_MIN_FONT_PX,
  barMetrics,
  layoutAttributionBar,
} from "./attributionBar";
// The renderer's capture width, restated here rather than imported: the
// tuning constants live in tileRenderer.ts, which imports Cesium, and these
// tests run in Node. If the capture width ever changes, this test states the
// baseline the bar's appearance was derived against.
const CAPTURE_WIDTH_PX = 800;

/**
 * Stand-in for a 2D context's text measurement: a fixed advance per character.
 * 0.5 em is close to a real sans-serif average and, more importantly, is
 * monotonic in length — which is the only property the wrap algorithm relies on.
 */
function measurer(fontPx: number): (s: string) => number {
  return (s) => s.length * fontPx * 0.5;
}

describe("attribution bar sizing", () => {
  it("renders at the historical 12 px on the baseline capture", () => {
    // The derivation changed; the baseline appearance must not have.
    expect(barMetrics(CAPTURE_WIDTH_PX).fontPx).toBe(12);
  });

  it("scales with the frame, so superSample no longer shrinks the credit", () => {
    // Cesium's resolutionScale multiplies the backing store and the capture
    // reads the backing store, so a 2x supersample arrives here as 2x width.
    const base = barMetrics(800);
    const supersampled = barMetrics(1600);

    expect(supersampled.fontPx).toBe(base.fontPx * 2);
    // Constant apparent size: the bar occupies the same fraction of the picture
    // at any capture size, which is the whole point of the change.
    expect(supersampled.fontPx / 1600).toBeCloseTo(base.fontPx / 800, 6);
  });

  it("keeps padding and leading proportional to the text", () => {
    for (const width of [800, 1200, 1600, 2400]) {
      const m = barMetrics(width);
      expect(m.lineHeightPx).toBeGreaterThan(m.fontPx);
      expect(m.padPx).toBeGreaterThan(0);
      expect(m.padPx).toBeLessThan(m.fontPx);
    }
  });

  it("never shrinks the text below the legibility floor", () => {
    expect(barMetrics(100).fontPx).toBe(BAR_MIN_FONT_PX);
    expect(barMetrics(1).fontPx).toBe(BAR_MIN_FONT_PX);
  });
});

describe("attribution bar wrapping", () => {
  const LONG =
    "Google Maps · Airbus, Maxar Technologies, Sanborn, USGS, New York GIS, " +
    "Vexcel Imaging US Inc., Landsat / Copernicus, Data SIO NOAA U.S. Navy NGA GEBCO";

  it("keeps a short credit on one line", () => {
    const bar = layoutAttributionBar(800, "Google Maps", measurer(12));
    expect(bar.lines).toEqual(["Google Maps"]);
  });

  it("wraps a long credit instead of truncating it", () => {
    const bar = layoutAttributionBar(800, LONG, measurer(12));

    expect(bar.lines.length).toBeGreaterThan(1);
    // Every word survives, in order. Truncation would be a compliance failure,
    // not a layout imperfection.
    expect(bar.lines.join(" ")).toBe(LONG);
  });

  it("grows the bar to fit the wrapped lines", () => {
    const one = layoutAttributionBar(800, "Google Maps", measurer(12));
    const many = layoutAttributionBar(800, LONG, measurer(12));

    expect(many.heightPx).toBeGreaterThan(one.heightPx);
    expect(many.heightPx).toBe(
      many.lines.length * many.lineHeightPx + many.padPx,
    );
  });

  it("respects the frame's own width when wrapping", () => {
    const narrow = layoutAttributionBar(400, LONG, measurer(BAR_MIN_FONT_PX));
    const wide = layoutAttributionBar(1600, LONG, measurer(24));

    // Same text, same relative type size: a wider frame fits it in no more
    // lines than a narrower one.
    expect(wide.lines.length).toBeLessThanOrEqual(narrow.lines.length);
    expect(wide.lines.join(" ")).toBe(LONG);
    expect(narrow.lines.join(" ")).toBe(LONG);
  });

  it("gives an unbreakable over-wide word its own line rather than dropping it", () => {
    const word = "x".repeat(500);
    const bar = layoutAttributionBar(800, `Google Maps ${word}`, measurer(12));

    expect(bar.lines).toContain(word);
    expect(bar.lines.join(" ")).toBe(`Google Maps ${word}`);
  });
});
