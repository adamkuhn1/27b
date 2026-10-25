import { describe, expect, it } from "vitest";
import { nearestSupportedFloor } from "./States";

// The Empire State Building's curated range (backend/planning.py).
const ESB = { min: 50, max: 102 };

describe("nearestSupportedFloor", () => {
  it("raises a floor below the range to its bottom", () => {
    expect(nearestSupportedFloor(12, ESB)).toBe(50);
    expect(nearestSupportedFloor(49, ESB)).toBe(50);
  });

  it("lowers a floor above the range to its top", () => {
    expect(nearestSupportedFloor(103, ESB)).toBe(102);
    expect(nearestSupportedFloor(130, ESB)).toBe(102);
  });

  it("leaves a floor already in range alone, including the ends", () => {
    expect(nearestSupportedFloor(50, ESB)).toBe(50);
    expect(nearestSupportedFloor(86, ESB)).toBe(86);
    expect(nearestSupportedFloor(102, ESB)).toBe(102);
  });

  it("handles a single-floor range", () => {
    expect(nearestSupportedFloor(1, { min: 70, max: 70 })).toBe(70);
    expect(nearestSupportedFloor(90, { min: 70, max: 70 })).toBe(70);
  });
});
