import { describe, it, expect } from "vitest";
import {
  ASSUMED_FLOOR_HEIGHT_M,
  EYE_ABOVE_FLOOR_M,
  FACADE_OFFSET_M,
  estimateFloorElevation,
  offsetLatLng,
  buildCameraViews,
  polygonCentroid,
  facadeDistanceM,
  principalFacadeAxis,
  viewBearings,
  pointInRingMeters,
  ringToLocalMeters,
} from "./geometry";
import { geoidHeightM } from "./geoid";
import type { BuildingFootprint } from "./types";

// A simple 100 m × 80 m rectangle centred at the building centroid (≈ ±50 m N/S,
// ±40 m E/W in degrees). Axis-aligned to true north on purpose so the facade
// basis and the compass basis coincide for the elevation/offset tests.
const CENTROID = { lat: 40.7128, lng: -74.006 };
const RING: Array<[number, number]> = [
  [CENTROID.lng - 0.00036, CENTROID.lat - 0.00045], // SW
  [CENTROID.lng + 0.00036, CENTROID.lat - 0.00045], // SE
  [CENTROID.lng + 0.00036, CENTROID.lat + 0.00045], // NE
  [CENTROID.lng - 0.00036, CENTROID.lat + 0.00045], // NW
  [CENTROID.lng - 0.00036, CENTROID.lat - 0.00045], // close
];

const building: BuildingFootprint = {
  bin: "1000000",
  roofHeightM: 100, // ~31 floors of headroom
  groundElevationNavd88M: 10,
  centroid: CENTROID,
  ring: RING,
};

/**
 * The Empire State Building's real NYC OpenData footprint ring (BIN 1015862,
 * dataset 5zhs-2jue, fetched 2026-08-04). Used to prove the facade math on a
 * building that is emphatically NOT aligned to true north.
 */
const ESB_RING: Array<[number, number]> = [
  [-73.98608527878, 40.748921498021],
  [-73.98482339139, 40.74839078918],
  [-73.984909832216, 40.748271913883],
  [-73.985031089296, 40.74810515772],
  [-73.985157291953, 40.747931600537],
  [-73.98648794223, 40.748491226399],
  [-73.986469871701, 40.748516078254],
  [-73.986682947706, 40.748605687253],
  [-73.98655560005, 40.748780826345],
  [-73.98635802669, 40.748697735913],
  [-73.986345130771, 40.748715469858],
  [-73.98632962892, 40.748708950154],
  [-73.986312563843, 40.748732419825],
  [-73.986154048034, 40.748950418863],
  [-73.98608527878, 40.748921498021],
];

const esb: BuildingFootprint = {
  bin: "1015862",
  roofHeightM: 1238.79032716 * 0.3048,
  groundElevationNavd88M: 50 * 0.3048,
  centroid: polygonCentroid(ESB_RING),
  ring: ESB_RING,
};

describe("estimateFloorElevation", () => {
  it("puts floor 1's eye at ground + eye height (in the source NAVD88 datum)", () => {
    const e = estimateFloorElevation(building, 1);
    expect(e.eyeElevationNavd88M).toBeCloseTo(10 + EYE_ABOVE_FLOOR_M, 6);
    expect(e.clampedToRoof).toBe(false);
  });

  it("adds one floor height per floor above the first", () => {
    const f5 = estimateFloorElevation(building, 5);
    const expectedAboveGround = 4 * ASSUMED_FLOOR_HEIGHT_M + EYE_ABOVE_FLOOR_M;
    expect(f5.eyeElevationNavd88M).toBeCloseTo(10 + expectedAboveGround, 6);
  });

  it("clamps to the real roof and never exceeds the building", () => {
    const tall = estimateFloorElevation(building, 200);
    expect(tall.clampedToRoof).toBe(true);
    expect(tall.eyeElevationNavd88M).toBeCloseTo(10 + 100, 6);
  });

  it("does not clamp when the floor fits under the roof", () => {
    const f10 = estimateFloorElevation(building, 10);
    expect(f10.clampedToRoof).toBe(false);
    expect(f10.eyeElevationNavd88M).toBeLessThan(
      building.groundElevationNavd88M + building.roofHeightM,
    );
  });

  it("converts NAVD88 to WGS84 ellipsoidal height (the ~32 m datum fix)", () => {
    const e = estimateFloorElevation(building, 27);
    const undulation = geoidHeightM(CENTROID.lat, CENTROID.lng);
    expect(undulation).toBeLessThan(-30); // NYC geoid is ~ -31.7 m
    expect(e.geoidHeightM).toBeCloseTo(undulation, 9);
    expect(e.eyeElevationEllipsoidalM).toBeCloseTo(
      e.eyeElevationNavd88M + undulation,
      9,
    );
    // The correction is worth about ten floors: it must not be a no-op.
    expect(e.eyeElevationNavd88M - e.eyeElevationEllipsoidalM).toBeGreaterThan(25);
  });

  it("keeps floors materially separated after the datum conversion", () => {
    const low = estimateFloorElevation(building, 4);
    const high = estimateFloorElevation(building, 28);
    const delta =
      high.eyeElevationEllipsoidalM - low.eyeElevationEllipsoidalM;
    expect(delta).toBeCloseTo(24 * ASSUMED_FLOOR_HEIGHT_M, 6);
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

describe("facadeDistanceM", () => {
  it("returns a positive distance for a north-facing ray on a rectangular ring", () => {
    const d = facadeDistanceM(RING, CENTROID, 0); // north
    expect(d).toBeGreaterThan(0);
    expect(d).toBeCloseTo(0.00045 * 111_320, 0);
  });

  it("is symmetric for opposite bearings on a symmetric ring", () => {
    const north = facadeDistanceM(RING, CENTROID, 0);
    const south = facadeDistanceM(RING, CENTROID, 180);
    expect(north).toBeCloseTo(south, 1);
  });

  it("returns 0 for a degenerate (< 3 point) ring", () => {
    expect(facadeDistanceM([[0, 0], [1, 1]], CENTROID, 0)).toBe(0);
  });

  it("takes the OUTERMOST crossing on a C-shaped (courtyard) footprint", () => {
    // C opening east; the area-weighted centroid falls in the notch, which is a
    // real situation for U- and C-shaped NYC buildings. Going north from there,
    // the ray ENTERS the top arm at ~30 m and leaves it at ~50 m. Using the
    // nearest crossing (the old behaviour) would put the camera 6 m past 30 m —
    // i.e. inside the building. The outermost crossing is the correct one.
    const c = { lat: 0, lng: 0 };
    const m = 1 / 111_320; // ~1 m in degrees latitude
    const ring: Array<[number, number]> = [
      [-50 * m, -50 * m],
      [50 * m, -50 * m],
      [50 * m, -30 * m],
      [-20 * m, -30 * m],
      [-20 * m, 30 * m],
      [50 * m, 30 * m],
      [50 * m, 50 * m],
      [-50 * m, 50 * m],
      [-50 * m, -50 * m],
    ];
    const d = facadeDistanceM(ring, c, 0);
    expect(d).toBeGreaterThan(45);
    expect(d).toBeLessThan(55);

    // ...and the camera built from it must land outside the polygon.
    const local = ringToLocalMeters(ring, c);
    expect(pointInRingMeters(local, 0, d + 6)).toBe(false);
    // Sanity: the nearest crossing would have been inside.
    expect(pointInRingMeters(local, 0, 30 + 6)).toBe(true);
  });
});

describe("principalFacadeAxis", () => {
  it("finds 0 degrees for a north-aligned rectangle, with high concentration", () => {
    const axis = principalFacadeAxis(RING, CENTROID);
    expect(axis.concentration).toBeGreaterThan(0.95);
    // Modulo 90: a north-aligned rectangle reads as 0 (or ~90, same axis).
    expect(Math.min(axis.bearingDeg, 90 - axis.bearingDeg)).toBeLessThan(1);
  });

  it("finds the Manhattan grid rotation (~29 deg) on the real ESB footprint", () => {
    const axis = principalFacadeAxis(ESB_RING, esb.centroid);
    expect(axis.concentration).toBeGreaterThan(0.8);
    // Manhattan's grid is rotated ~29 deg clockwise from true north; the ESB
    // footprint should report an axis near 29 (mod 90).
    const nearest = Math.min(
      Math.abs(axis.bearingDeg - 29),
      Math.abs(axis.bearingDeg - 29 + 90),
      Math.abs(axis.bearingDeg - 29 - 90),
    );
    expect(nearest).toBeLessThan(6);
  });

  it("reports low concentration for a near-circular footprint", () => {
    const ring: Array<[number, number]> = [];
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * 2 * Math.PI;
      ring.push([
        CENTROID.lng + 0.0003 * Math.cos(a),
        CENTROID.lat + 0.0003 * Math.sin(a),
      ]);
    }
    expect(principalFacadeAxis(ring, CENTROID).concentration).toBeLessThan(0.3);
  });
});

describe("viewBearings", () => {
  it("uses the facade basis for a strongly rectilinear footprint", () => {
    const { basis, bearingsDeg } = viewBearings(building);
    expect(basis).toBe("facade");
    expect(bearingsDeg).toHaveLength(4);
    // Four bearings, 90 degrees apart.
    for (let i = 1; i < 4; i++) {
      expect(bearingsDeg[i] - bearingsDeg[0]).toBeCloseTo(90 * i, 6);
    }
  });

  it("falls back to true compass views when there is no dominant facade", () => {
    const ring: Array<[number, number]> = [];
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * 2 * Math.PI;
      ring.push([
        CENTROID.lng + 0.0003 * Math.cos(a),
        CENTROID.lat + 0.0003 * Math.sin(a),
      ]);
    }
    const { basis, bearingsDeg } = viewBearings({ ...building, ring });
    expect(basis).toBe("compass");
    expect(bearingsDeg).toEqual([0, 90, 180, 270]);
  });
});

describe("buildCameraViews", () => {
  it("produces four slots with 90-degree separation and a downward pitch", () => {
    const { views } = buildCameraViews(building, 50, 40);
    expect(views.map((v) => v.slot)).toEqual(["V1", "V2", "V3", "V4"]);
    for (const v of views) {
      expect(v.heightM).toBe(50);
      expect(v.pitchDeg).toBeLessThan(0);
      expect(v.pitchDeg).toBeGreaterThanOrEqual(-9);
      expect(v.compass).toMatch(/^[NESW]{1,3}$/);
    }
  });

  it("places every camera OUTSIDE the footprint polygon", () => {
    for (const fp of [building, esb]) {
      const { views } = buildCameraViews(fp, 50, 40);
      const local = ringToLocalMeters(fp.ring, fp.centroid);
      for (const v of views) {
        const p = ringToLocalMeters([[v.lng, v.lat]], fp.centroid)[0];
        expect(pointInRingMeters(local, p[0], p[1])).toBe(false);
        expect(v.standoffM).toBeGreaterThanOrEqual(FACADE_OFFSET_M);
      }
    }
  });

  it("aims the real ESB views along its facades, not true north", () => {
    const { views, basis } = buildCameraViews(esb, 300, 250);
    expect(basis).toBe("facade");
    // No view should be within 5 degrees of a cardinal direction, because the
    // building sits on the rotated Manhattan grid.
    for (const v of views) {
      const offGrid = Math.min(
        ...[0, 90, 180, 270, 360].map((c) => Math.abs(v.headingDeg - c)),
      );
      expect(offGrid).toBeGreaterThan(5);
    }
  });

  it("moves the camera up when the floor goes up, and nothing else", () => {
    const low = buildCameraViews(building, 20, 10).views;
    const high = buildCameraViews(building, 120, 110).views;
    for (let i = 0; i < 4; i++) {
      expect(high[i].heightM - low[i].heightM).toBeCloseTo(100, 6);
      expect(high[i].lat).toBeCloseTo(low[i].lat, 9);
      expect(high[i].lng).toBeCloseTo(low[i].lng, 9);
      expect(high[i].headingDeg).toBeCloseTo(low[i].headingDeg, 9);
    }
  });

  it("reports the footprint's rectangularity instead of discarding it", () => {
    // Computed on every request and previously thrown away except as a boolean
    // gate. It is a real measurement about an unusual building and the visitor
    // should be able to see it.
    expect(buildCameraViews(building, 50, 40).concentration).toBeGreaterThan(0.9);
    expect(buildCameraViews(esb, 300, 250).concentration).toBeGreaterThan(0.8);
  });

  it("never needs the placement guard on a concave footprint, because the raycast takes the outermost crossing", () => {
    // Worth pinning as a property rather than assuming it. The guard loop that
    // pushes the camera further out if it lands back inside the polygon is a
    // safety net for pathological rings; for any simple ring — including a C
    // whose centroid sits in the notch — the outermost-crossing raycast has
    // already left the polygon for good, so the guard provably never fires.
    // ("How far the guard had to push" was considered as a real measurement
    // to surface, but it's structurally always zero -- a field that could
    // only ever read 0 -- so it was left out.)
    const m = 1 / 111_320;
    const c = { lat: 0, lng: 0 };
    const ring: Array<[number, number]> = [
      [-50 * m, -50 * m],
      [50 * m, -50 * m],
      [50 * m, -30 * m],
      [-20 * m, -30 * m],
      [-20 * m, 30 * m],
      [50 * m, 30 * m],
      [50 * m, 50 * m],
      [-50 * m, 50 * m],
      [-50 * m, -50 * m],
    ];
    const concave = {
      bin: "9",
      roofHeightM: 40,
      groundElevationNavd88M: 0,
      centroid: c,
      ring,
    };
    const { views } = buildCameraViews(concave, 30, 20);
    const local = ringToLocalMeters(ring, c);
    for (const v of views) {
      const p = ringToLocalMeters([[v.lng, v.lat]], c)[0];
      expect(pointInRingMeters(local, p[0], p[1])).toBe(false);
      // Exactly the raycast distance plus the fixed offset: no extra push.
      const wall = facadeDistanceM(ring, c, v.headingDeg);
      expect(v.standoffM).toBeCloseTo(wall + FACADE_OFFSET_M, 6);
    }
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
    const ring: Array<[number, number]> = [
      [0, 0],
      [0, 3],
      [1, 3],
      [1, 1],
      [3, 1],
      [3, 0],
    ];
    const c = polygonCentroid(ring);
    expect(c.lng).toBeGreaterThan(0);
    expect(c.lng).toBeLessThan(3);
    expect(c.lat).toBeGreaterThan(0);
    expect(c.lat).toBeLessThan(3);
  });

  it("throws on an empty ring rather than inventing a point", () => {
    expect(() => polygonCentroid([])).toThrow();
  });
});
