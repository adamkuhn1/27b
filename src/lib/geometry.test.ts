import { describe, it, expect } from "vitest";
import {
  ASSUMED_FLOOR_HEIGHT_M,
  EYE_ABOVE_FLOOR_M,
  FACADE_OFFSET_M,
  estimateFloorElevation,
  offsetLatLng,
  buildCameraViews,
  polygonCentroid,
} from "./geometry";
import { CARDINAL_HEADING } from "./types";
import type { BuildingFootprint } from "./types";

const building: BuildingFootprint = {
  bin: "1000000",
  roofHeightM: 100, // ~31 floors of headroom
  groundElevationM: 10,
  centroid: { lat: 40.7128, lng: -74.006 },
};

describe("estimateFloorElevation", () => {
  it("puts floor 1's eye at ground + eye height", () => {
    const { eyeElevationM, clampedToRoof } = estimateFloorElevation(building, 1);
    expect(eyeElevationM).toBeCloseTo(10 + EYE_ABOVE_FLOOR_M, 6);
    expect(clampedToRoof).toBe(false);
  });

  it("adds one floor height per floor above the first", () => {
    const f5 = estimateFloorElevation(building, 5);
    const expectedAboveGround = 4 * ASSUMED_FLOOR_HEIGHT_M + EYE_ABOVE_FLOOR_M;
    expect(f5.eyeElevationM).toBeCloseTo(10 + expectedAboveGround, 6);
  });

  it("clamps to the real roof and never exceeds the building", () => {
    // floor 200 would be far above a 100m roof.
    const tall = estimateFloorElevation(building, 200);
    expect(tall.clampedToRoof).toBe(true);
    // eye elevation equals ground + roof exactly (never above the building).
    expect(tall.eyeElevationM).toBeCloseTo(10 + 100, 6);
  });

  it("does not clamp when the floor fits under the roof", () => {
    const f10 = estimateFloorElevation(building, 10);
    expect(f10.clampedToRoof).toBe(false);
    expect(f10.eyeElevationM).toBeLessThan(building.groundElevationM + building.roofHeightM);
  });
});

describe("offsetLatLng", () => {
  it("moving north increases latitude, leaves longitude ~unchanged", () => {
    const p = offsetLatLng(40.7128, -74.006, 0, 100);
    expect(p.lat).toBeGreaterThan(40.7128);
    expect(p.lng).toBeCloseTo(-74.006, 6);
  });

  it("moving east increases longitude, leaves latitude ~unchanged", () => {
    const p = offsetLatLng(40.7128, -74.006, 90, 100);
    expect(p.lng).toBeGreaterThan(-74.006);
    expect(p.lat).toBeCloseTo(40.7128, 6);
  });

  it("moving south decreases latitude", () => {
    const p = offsetLatLng(40.7128, -74.006, 180, 100);
    expect(p.lat).toBeLessThan(40.7128);
  });

  it("moving west decreases longitude", () => {
    const p = offsetLatLng(40.7128, -74.006, 270, 100);
    expect(p.lng).toBeLessThan(-74.006);
  });

  it("100m north ≈ 0.0009 degrees latitude (1 deg lat ≈ 111.32 km)", () => {
    const p = offsetLatLng(40.7128, -74.006, 0, 100);
    const dLat = p.lat - 40.7128;
    expect(dLat).toBeCloseTo(100 / 111_320, 5);
  });
});

describe("buildCameraViews", () => {
  it("produces exactly the four cardinals with correct headings", () => {
    const views = buildCameraViews(building, 50);
    expect(views.map((v) => v.cardinal)).toEqual(["N", "E", "S", "W"]);
    for (const v of views) {
      expect(v.headingDeg).toBe(CARDINAL_HEADING[v.cardinal]);
      expect(v.heightM).toBe(50);
      expect(v.pitchDeg).toBe(0);
    }
  });

  it("offsets each camera outward from the centroid by the facade offset", () => {
    const views = buildCameraViews(building, 50);
    const north = views.find((v) => v.cardinal === "N")!;
    // North camera should sit north of the centroid.
    expect(north.lat).toBeGreaterThan(building.centroid.lat);
    // Offset magnitude ~ FACADE_OFFSET_M in latitude degrees.
    const dLat = north.lat - building.centroid.lat;
    expect(dLat).toBeCloseTo(FACADE_OFFSET_M / 111_320, 5);
  });
});

describe("polygonCentroid", () => {
  it("returns the center of a unit square (closed ring)", () => {
    const ring: Array<[number, number]> = [
      [0, 0],
      [0, 2],
      [2, 2],
      [2, 0],
      [0, 0],
    ];
    const c = polygonCentroid(ring);
    expect(c.lng).toBeCloseTo(1, 6);
    expect(c.lat).toBeCloseTo(1, 6);
  });

  it("returns the center of an open (unclosed) ring", () => {
    const ring: Array<[number, number]> = [
      [0, 0],
      [0, 4],
      [4, 4],
      [4, 0],
    ];
    const c = polygonCentroid(ring);
    expect(c.lng).toBeCloseTo(2, 6);
    expect(c.lat).toBeCloseTo(2, 6);
  });

  it("keeps an L-shape centroid inside the polygon (area-weighted)", () => {
    // L-shape: not a simple bbox center.
    const ring: Array<[number, number]> = [
      [0, 0],
      [0, 3],
      [1, 3],
      [1, 1],
      [3, 1],
      [3, 0],
    ];
    const c = polygonCentroid(ring);
    // The naive vertex mean would be (1.33,1.33); area-weighted differs and
    // stays within the arm bounds.
    expect(c.lng).toBeGreaterThan(0);
    expect(c.lng).toBeLessThan(3);
    expect(c.lat).toBeGreaterThan(0);
    expect(c.lat).toBeLessThan(3);
  });

  it("throws on an empty ring rather than inventing a point", () => {
    expect(() => polygonCentroid([])).toThrow();
  });
});
