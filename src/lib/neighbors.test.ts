import { describe, it, expect } from "vitest";
import { parseNeighbors, wktBox } from "./neighbors";
import { assessConfidence } from "./confidence";
import type { CameraView } from "./types";
import esbRaw from "./__fixtures__/esb.json";

const ESB_BIN = "1015862";

describe("wktBox", () => {
  it("is a closed ring in (lng lat) order", () => {
    const wkt = wktBox(40.7484, -73.9857, 220);
    expect(wkt.startsWith("POLYGON((")).toBe(true);
    const pts = wkt
      .slice("POLYGON((".length, -2)
      .split(",")
      .map((p) => p.trim().split(" ").map(Number));
    expect(pts).toHaveLength(5);
    expect(pts[0]).toEqual(pts[4]);
    // x is longitude (negative in NYC), y is latitude.
    expect(pts.every(([x, y]) => x < -73 && y > 40)).toBe(true);
  });

  it("sizes the box to the requested radius in metres, both axes", () => {
    const lat = 40.7484;
    const wkt = wktBox(lat, -73.9857, 220);
    const pts = wkt
      .slice("POLYGON((".length, -2)
      .split(",")
      .map((p) => p.trim().split(" ").map(Number));
    const lats = pts.map((p) => p[1]);
    const lngs = pts.map((p) => p[0]);
    const heightM = (Math.max(...lats) - Math.min(...lats)) * 111_320;
    const widthM =
      (Math.max(...lngs) - Math.min(...lngs)) *
      111_320 *
      Math.cos((lat * Math.PI) / 180);
    expect(heightM).toBeCloseTo(440, 0);
    expect(widthM).toBeCloseTo(440, 0);
  });
});

describe("parseNeighbors — absence is not zero", () => {
  const ring = [
    [-73.99, 40.75],
    [-73.989, 40.75],
    [-73.989, 40.751],
    [-73.99, 40.751],
    [-73.99, 40.75],
  ];
  const geom = { type: "Polygon", coordinates: [ring] };

  it("converts feet to metres", () => {
    const { neighbors } = parseNeighbors([
      { bin: "1", height_roof: "100", ground_elevation: "50", the_geom: geom },
    ]);
    expect(neighbors[0].roofHeightM).toBeCloseTo(30.48, 4);
    expect(neighbors[0].groundElevationNavd88M).toBeCloseTo(15.24, 4);
  });

  it("keeps a missing ground elevation as null, never as 0", () => {
    // 0 would say "this building sits at sea level", understating its top by
    // up to ~60 m in the Bronx and Staten Island. null lets the caller
    // substitute the subject's own ground elevation instead.
    const { neighbors, incomplete } = parseNeighbors([
      { bin: "1", height_roof: "100", the_geom: geom },
    ]);
    expect(neighbors[0].groundElevationNavd88M).toBeNull();
    expect(incomplete).toBe(false);
  });

  it("skips a building with no roof height and flags the result incomplete", () => {
    // An unknown height is an unknown. Treating it as zero would assert open
    // sky where there might be a tower.
    const { neighbors, incomplete } = parseNeighbors([
      { bin: "1", height_roof: "100", ground_elevation: "0", the_geom: geom },
      { bin: "2", ground_elevation: "0", the_geom: geom },
    ]);
    expect(neighbors.map((n) => n.bin)).toEqual(["1"]);
    expect(incomplete).toBe(true);
  });

  it("skips a zero or negative roof height the same way", () => {
    const { neighbors, incomplete } = parseNeighbors([
      { bin: "1", height_roof: "0", the_geom: geom },
    ]);
    expect(neighbors).toHaveLength(0);
    expect(incomplete).toBe(true);
  });

  it("skips a record with no usable geometry and flags it", () => {
    const { neighbors, incomplete } = parseNeighbors([
      { bin: "1", height_roof: "100", the_geom: { type: "Polygon", coordinates: [] } },
    ]);
    expect(neighbors).toHaveLength(0);
    expect(incomplete).toBe(true);
  });

  it("reads the outer ring of a MultiPolygon", () => {
    const { neighbors } = parseNeighbors([
      {
        bin: "1",
        height_roof: "100",
        the_geom: { type: "MultiPolygon", coordinates: [[ring]] },
      },
    ]);
    expect(neighbors[0].ring).toHaveLength(ring.length);
  });
});

// -----------------------------------------------------------------------------
// The within_circle trap, pinned
// -----------------------------------------------------------------------------
//
// SoQL's within_circle() on a polygon column means "entirely contained", not
// "intersects". Measured live on 2026-08-05 against the free endpoint, centred
// on the Empire State Building's own centroid:
//
//   within_circle(the_geom, ..., 40)  ->   0 rows  (the ESB is NOT returned)
//   within_circle(the_geom, ..., 150) ->  40 rows  (the ESB IS returned)
//   intersects(the_geom, 220 m box)   -> 202 rows
//
// The measurement is recorded in
// docs/repair/personal-authorship-sprint/evidence/27b-soql-within-circle.json.
// What is pinned here is the CONSEQUENCE: a big straddling neighbour is the one
// that dominates the obstruction answer, so dropping it is not a rounding error.

describe("straddling neighbours are the ones that matter", () => {
  const camera: CameraView = {
    slot: "V1",
    headingDeg: 29,
    compass: "NNE",
    lat: 40.7484,
    lng: -73.9857,
    heightM: 40,
    pitchDeg: -3,
    standoffM: 36,
    wallDistanceM: 30,
  };

  function bandWith(bins: (bin: string) => boolean) {
    const { neighbors, incomplete } = parseNeighbors(
      (esbRaw.neighbors as never[]).filter((r: { bin?: string }) =>
        bins(r.bin ?? ""),
      ),
    );
    return assessConfidence({
      views: [camera],
      eyeElevationNavd88M: 30,
      subjectBin: "SUBJECT-NOT-PRESENT",
      subjectGroundElevationNavd88M: 10,
      neighbors,
      neighborDataIncomplete: incomplete,
    }).bySlot.V1!;
  }

  it("changes the answer when the large straddling building is dropped", () => {
    const withEsb = bandWith(() => true);
    const withoutEsb = bandWith((bin) => bin !== ESB_BIN);

    // The ESB's own footprint spans ~190 m; a 40 m within_circle() around this
    // camera would silently omit it. Its presence measurably raises the
    // obstruction angle for a low camera looking along the 29° facade.
    expect(withEsb.maxObstructionAngleDeg).toBeGreaterThan(
      withoutEsb.maxObstructionAngleDeg,
    );
  });

  it("is present in the committed fixture at all", () => {
    // Guards the fixture itself: if a future re-capture used within_circle,
    // the subject's own record would vanish from its neighbour set and this
    // test would go red rather than silently weakening every calibration case.
    const bins = new Set(
      (esbRaw.neighbors as Array<{ bin?: string }>).map((r) => r.bin),
    );
    expect(bins.has(ESB_BIN)).toBe(true);
  });
});
