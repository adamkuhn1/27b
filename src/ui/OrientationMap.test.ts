import { describe, expect, it } from "vitest";
import { MAP_SIZE, gridOffsetDeg, orientationCaption, projectViews } from "./OrientationMap";
import type { CameraView, ViewSlot } from "../lib/types";

// The Dakota's centroid, roughly: a real Manhattan latitude, so the cos(lat)
// correction (~0.758) is far from 1.
const CENTROID = { lat: 40.7767, lng: -73.9761 };
const M_PER_DEG = (Math.PI / 180) * 6_371_008.8;
const COS_LAT = Math.cos((CENTROID.lat * Math.PI) / 180);
const C = MAP_SIZE / 2;

/** A camera `standoffM` meters from the centroid along `headingDeg`. */
function view(slot: ViewSlot, headingDeg: number, compass: string, standoffM = 30): CameraView {
  const h = (headingDeg * Math.PI) / 180;
  return {
    slot,
    headingDeg,
    compass,
    lat: CENTROID.lat + (standoffM * Math.cos(h)) / M_PER_DEG,
    lng: CENTROID.lng + (standoffM * Math.sin(h)) / (M_PER_DEG * COS_LAT),
    heightM: 100,
    pitchDeg: 0,
    standoffM,
  };
}

/** Screen bearing of a vector in SVG coordinates (0 = up, clockwise). */
function screenBearing(dx: number, dy: number): number {
  return (((Math.atan2(dx, -dy) * 180) / Math.PI) + 360) % 360;
}

const COMPASS = [view("V1", 0, "N"), view("V2", 90, "E"), view("V3", 180, "S"), view("V4", 270, "W")];
const MANHATTAN = [
  view("V1", 29, "NNE"),
  view("V2", 119, "ESE"),
  view("V3", 209, "SSW"),
  view("V4", 299, "WNW"),
];

describe("projectViews", () => {
  it("puts compass cameras straight up, right, down and left of the centre", () => {
    const [n, e, s, w] = projectViews(COMPASS, CENTROID);
    expect(n.x).toBeCloseTo(C);
    expect(n.y).toBeLessThan(C);
    expect(e.x).toBeGreaterThan(C);
    expect(e.y).toBeCloseTo(C);
    expect(s.x).toBeCloseTo(C);
    expect(s.y).toBeGreaterThan(C);
    expect(w.x).toBeLessThan(C);
    expect(w.y).toBeCloseTo(C);
  });

  it("corrects longitude for latitude, so equal meters give equal pixels", () => {
    const [n, e] = projectViews(COMPASS, CENTROID);
    expect(C - n.y).toBeCloseTo(e.x - C, 3);
  });

  it("aims each arrow along its true heading", () => {
    for (const a of projectViews(MANHATTAN, CENTROID)) {
      expect(screenBearing(a.tipX - a.x, a.tipY - a.y)).toBeCloseTo(a.headingDeg, 6);
    }
  });

  it("places each camera along its heading from the centre", () => {
    for (const a of projectViews(MANHATTAN, CENTROID)) {
      expect(screenBearing(a.x - C, a.y - C)).toBeCloseTo(a.headingDeg, 3);
    }
  });

  it("keeps relative standoffs: a nearer camera sits nearer the centre", () => {
    const [near, far] = projectViews([view("V1", 29, "NNE", 15), view("V2", 119, "ESE", 45)], CENTROID);
    const rNear = Math.hypot(near.x - C, near.y - C);
    const rFar = Math.hypot(far.x - C, far.y - C);
    expect(rNear / rFar).toBeCloseTo(1 / 3, 3);
  });

  it("keeps every point inside the viewBox", () => {
    for (const a of projectViews(MANHATTAN, CENTROID)) {
      for (const v of [a.x, a.y, a.tipX, a.tipY, a.labelX, a.labelY]) {
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThan(MAP_SIZE);
      }
    }
  });

  it("carries the plan's compass labels and anchors them away from the arrow", () => {
    const arrows = projectViews(COMPASS, CENTROID);
    expect(arrows.map((a) => a.compass)).toEqual(["N", "E", "S", "W"]);
    expect(arrows.map((a) => a.anchor)).toEqual(["middle", "start", "middle", "end"]);
  });

  it("still draws a readable diagram if every camera sits on the centroid", () => {
    const stacked = MANHATTAN.map((v) => ({ ...v, lat: CENTROID.lat, lng: CENTROID.lng }));
    for (const a of projectViews(stacked, CENTROID)) {
      expect(Number.isFinite(a.x) && Number.isFinite(a.y)).toBe(true);
      expect(screenBearing(a.x - C, a.y - C)).toBeCloseTo(a.headingDeg, 6);
    }
  });
});

describe("gridOffsetDeg / orientationCaption", () => {
  it("measures the skew from the compass grid", () => {
    expect(gridOffsetDeg(COMPASS)).toBe(0);
    expect(gridOffsetDeg(MANHATTAN)).toBeCloseTo(29);
    expect(gridOffsetDeg([view("V1", 331, "NNW")])).toBeCloseTo(-29);
    expect(gridOffsetDeg([])).toBeNull();
  });

  it("describes the bearings honestly", () => {
    expect(orientationCaption("facade", MANHATTAN)).toBe("Views follow the walls, 29° east of north");
    expect(orientationCaption("facade", [view("V1", 331, "NNW")])).toBe(
      "Views follow the walls, 29° west of north",
    );
    expect(orientationCaption("facade", COMPASS)).toBe("Views follow the walls, square to north");
    expect(orientationCaption("compass", COMPASS)).toBe("Views face true N, E, S and W");
  });
});
