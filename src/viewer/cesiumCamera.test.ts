import { describe, it, expect } from "vitest";
import { toCesiumOrientation } from "./cesiumCamera";
import type { CameraView } from "../lib/types";

function view(headingDeg: number, pitchDeg = 0): CameraView {
  return {
    slot: "V1",
    headingDeg,
    compass: "N",
    lat: 40.7,
    lng: -74,
    heightM: 50,
    pitchDeg,
    standoffM: 26,
    wallDistanceM: 20,
  };
}

const DEG = Math.PI / 180;

describe("toCesiumOrientation", () => {
  it("converts heading degrees to radians", () => {
    expect(toCesiumOrientation(view(90)).heading).toBeCloseTo(90 * DEG, 9);
    expect(toCesiumOrientation(view(270)).heading).toBeCloseTo(270 * DEG, 9);
  });

  it("keeps horizon pitch (0) as 0 radians", () => {
    expect(toCesiumOrientation(view(0, 0)).pitch).toBeCloseTo(0, 9);
  });

  it("converts a downward pitch to negative radians", () => {
    expect(toCesiumOrientation(view(0, -10)).pitch).toBeCloseTo(-10 * DEG, 9);
  });

  it("always produces zero roll (no camera tilt)", () => {
    expect(toCesiumOrientation(view(45, 5)).roll).toBe(0);
  });
});
