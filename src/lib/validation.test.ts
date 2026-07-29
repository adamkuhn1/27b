import { describe, it, expect } from "vitest";
import {
  validateAddress,
  validateFloor,
  isWithinNyc,
  MAX_FLOOR,
} from "./validation";

describe("validateAddress", () => {
  it("accepts a house-number + street address", () => {
    const r = validateAddress("  11   Wall   St ");
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe("11 Wall St"); // whitespace collapsed
  });

  it("rejects empty input", () => {
    expect(validateAddress("").valid).toBe(false);
    expect(validateAddress("   ").valid).toBe(false);
  });

  it("rejects a bare neighborhood name with no house number", () => {
    const r = validateAddress("Times Square");
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/house number/i);
  });

  it("accepts an alphanumeric house number like 20A", () => {
    expect(validateAddress("20A Broadway").valid).toBe(true);
  });
});

describe("validateFloor", () => {
  it("accepts a positive integer", () => {
    expect(validateFloor("27")).toEqual({ valid: true, floor: 27 });
  });

  it("accepts a number type", () => {
    expect(validateFloor(3).valid).toBe(true);
  });

  it("rejects zero and negatives", () => {
    expect(validateFloor("0").valid).toBe(false);
    expect(validateFloor("-4").valid).toBe(false);
  });

  it("rejects non-numeric input", () => {
    expect(validateFloor("penthouse").valid).toBe(false);
  });

  it("rejects a floor above the sane ceiling", () => {
    expect(validateFloor(String(MAX_FLOOR + 1)).valid).toBe(false);
  });

  it("accepts the ceiling exactly", () => {
    expect(validateFloor(String(MAX_FLOOR)).valid).toBe(true);
  });
});

describe("isWithinNyc", () => {
  it("accepts a midtown Manhattan point", () => {
    expect(isWithinNyc(40.7549, -73.984)).toBe(true);
  });

  it("accepts a Staten Island point", () => {
    expect(isWithinNyc(40.58, -74.15)).toBe(true);
  });

  it("rejects Los Angeles", () => {
    expect(isWithinNyc(34.0522, -118.2437)).toBe(false);
  });

  it("rejects a point just north of the bbox", () => {
    expect(isWithinNyc(41.0, -73.9)).toBe(false);
  });
});
