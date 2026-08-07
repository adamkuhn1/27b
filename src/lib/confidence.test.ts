// The enclosure metric, against four real NYC buildings and against synthetic
// geometry designed to break it.
//
// Everything here is offline: the footprints are committed fixtures captured
// once from free, keyless NYC Open Data. No provider endpoint is contacted and
// no imagery is involved, which is the whole design of this layer.

import { describe, it, expect } from "vitest";
import {
  assessConfidence,
  bearingDeltaDeg,
  classifyBand,
  CONE_HALF_ANGLE_DEG,
  isRenderableDirection,
  SEARCH_RADIUS_M,
} from "./confidence";
import { RENDER_TUNING } from "../viewer/renderTuning";
import { loadCase, type RawFixture } from "./__fixtures__/loader";
import type { CameraView, NeighborBuilding } from "./types";
import esbRaw from "./__fixtures__/esb.json";
import flatironRaw from "./__fixtures__/flatiron.json";
import e79Raw from "./__fixtures__/e79.json";
import dakotaRaw from "./__fixtures__/dakota.json";

const ESB = esbRaw as unknown as RawFixture;
const FLATIRON = flatironRaw as unknown as RawFixture;
const E79 = e79Raw as unknown as RawFixture;
const DAKOTA = dakotaRaw as unknown as RawFixture;

function assess(raw: RawFixture, floor: number) {
  const c = loadCase(raw, floor);
  return {
    ...c,
    report: assessConfidence({
      views: c.views,
      eyeElevationNavd88M: c.eyeElevationNavd88M,
      subjectBin: c.bin,
      subjectGroundElevationNavd88M: c.footprint.groundElevationNavd88M,
      neighbors: c.neighbors,
      neighborDataIncomplete: c.neighborDataIncomplete,
    }),
  };
}

const bands = (raw: RawFixture, floor: number) => {
  const { views, report } = assess(raw, floor);
  return views.map((v) => report.bySlot[v.slot]!.band);
};

describe("band classification", () => {
  it("is open only when nothing near AND nothing high", () => {
    expect(classifyBand(-30, null)).toBe("open");
    expect(classifyBand(5, 90)).toBe("open");
    // High enough to matter even though nothing is close.
    expect(classifyBand(25, 200)).toBe("partly-enclosed");
    // Close enough to matter even though nothing is high.
    expect(classifyBand(-5, 40)).toBe("partly-enclosed");
  });

  it("is enclosed on either the distance rule or the angle rule alone", () => {
    expect(classifyBand(-20, 20)).toBe("enclosed");
    expect(classifyBand(40, 500)).toBe("enclosed");
  });

  it("treats 'nothing blocking' as infinitely far, not as zero", () => {
    // A null firstBlocking read as 0 would call every open view enclosed.
    expect(classifyBand(-45, null)).toBe("open");
  });
});

describe("bearing arithmetic", () => {
  it("wraps across north", () => {
    expect(bearingDeltaDeg(359, 1)).toBeCloseTo(2, 6);
    expect(bearingDeltaDeg(10, 350)).toBeCloseTo(20, 6);
    expect(bearingDeltaDeg(29, 29)).toBeCloseTo(0, 6);
    expect(bearingDeltaDeg(0, 180)).toBeCloseTo(180, 6);
  });
});

describe("Empire State Building — floor 6 vs floor 80, same building", () => {
  it("calls every direction enclosed from floor 6", () => {
    expect(bands(ESB, 6)).toEqual([
      "enclosed",
      "enclosed",
      "enclosed",
      "enclosed",
    ]);
  });

  it("calls every direction open from floor 80", () => {
    expect(bands(ESB, 80)).toEqual(["open", "open", "open", "open"]);
  });

  it("finds nothing above the eye line at all from floor 80", () => {
    const { views, report } = assess(ESB, 80);
    for (const v of views) {
      const c = report.bySlot[v.slot]!;
      expect(c.firstBlockingM).toBeNull();
      expect(c.maxObstructionAngleDeg).toBeLessThan(0);
    }
  });

  it("uses the real rectangular footprint (concentration ~1, axis on the Manhattan grid)", () => {
    const { facadeConcentration, views } = assess(ESB, 80);
    expect(facadeConcentration).toBeGreaterThan(0.95);
    expect(views[0].headingDeg).toBeGreaterThan(25);
    expect(views[0].headingDeg).toBeLessThan(33);
  });
});

describe("425 E 79th St floor 10 — the typical residential case", () => {
  it("calls at least three of four directions enclosed", () => {
    const enclosed = bands(E79, 10).filter((b) => b === "enclosed").length;
    expect(enclosed).toBeGreaterThanOrEqual(3);
  });

  it("finds a neighbour within 25 m in at least one direction", () => {
    const { views, report } = assess(E79, 10);
    const nearest = views
      .map((v) => report.bySlot[v.slot]!.firstBlockingM)
      .filter((d): d is number => d !== null);
    expect(Math.min(...nearest)).toBeLessThan(25);
  });
});

describe("Flatiron floor 18 — discrimination inside one building", () => {
  // The harder test: the proof package called one of these the best frame in
  // the whole package and another the weakest of the Flatiron's own four.
  it("does not give all four directions the same band", () => {
    const set = new Set(bands(FLATIRON, 18));
    expect(set.size).toBeGreaterThan(1);
  });

  it("has at least one open and at least one enclosed direction", () => {
    const b = bands(FLATIRON, 18);
    expect(b).toContain("open");
    expect(b).toContain("enclosed");
  });

  it("measures the triangular footprint as a loose facade fit", () => {
    const { facadeConcentration } = assess(FLATIRON, 18);
    expect(facadeConcentration).toBeGreaterThan(0.5);
    expect(facadeConcentration).toBeLessThan(0.8);
  });
});

describe("the calibration table, regenerated by this implementation", () => {
  // Printed rather than only asserted so the numbers can be read off a test
  // run and compared against the recon's vertex-sampling probe. This
  // implementation samples EDGES, so its angles are equal or higher.
  it("records max obstruction angle and first blocking distance for 16 directions", () => {
    const rows: Array<Record<string, unknown>> = [];
    for (const [name, raw, floor] of [
      ["ESB fl 6", ESB, 6],
      ["ESB fl 80", ESB, 80],
      ["425 E 79th fl 10", E79, 10],
      ["Flatiron fl 18", FLATIRON, 18],
    ] as Array<[string, RawFixture, number]>) {
      const { views, report } = assess(raw, floor);
      for (const v of views) {
        const c = report.bySlot[v.slot]!;
        rows.push({
          case: name,
          bearing: Number(v.headingDeg.toFixed(1)),
          standoffM: Number(v.standoffM.toFixed(1)),
          maxAngleDeg: Number(c.maxObstructionAngleDeg.toFixed(1)),
          firstBlockingM:
            c.firstBlockingM === null ? null : Number(c.firstBlockingM.toFixed(1)),
          band: c.band,
        });
      }
    }
    // eslint-disable-next-line no-console -- this table is the point of the test
    console.log(`\nCALIBRATION\n${JSON.stringify(rows, null, 1)}\n`);
    expect(rows).toHaveLength(16);
    // Every "photographic" direction in the proof package is ESB floor 80.
    expect(rows.filter((r) => r.case === "ESB fl 80").every((r) => r.band === "open")).toBe(
      true,
    );
    // Every direction the package called melted/blurred/unreadable.
    expect(
      rows
        .filter((r) => r.case === "ESB fl 6" || r.case === "425 E 79th fl 10")
        .every((r) => r.band === "enclosed"),
    ).toBe(true);
  });
});

describe("the report itself", () => {
  it("counts the neighbours it used and excludes the subject building", () => {
    const { report, neighbors } = assess(ESB, 80);
    expect(report.neighborsConsidered).toBe(
      neighbors.filter((n) => n.bin !== ESB.bin).length,
    );
    expect(report.neighborsConsidered).toBeLessThan(neighbors.length);
    expect(report.searchRadiusM).toBe(SEARCH_RADIUS_M);
  });

  it("produces one entry per view", () => {
    const { views, report } = assess(DAKOTA, 10);
    expect(Object.keys(report.bySlot).sort()).toEqual(
      views.map((v) => v.slot).sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Synthetic geometry: cases real fixtures cannot pin precisely
// ---------------------------------------------------------------------------

const M_PER_DEG_LAT = 111_320;

/** A rectangle in metres east/north of an origin, as a [lng,lat] ring. */
function boxAt(
  origin: { lat: number; lng: number },
  eastM: number,
  northM: number,
  halfWidthM: number,
  halfDepthM: number,
): Array<[number, number]> {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  const pt = (e: number, n: number): [number, number] => [
    origin.lng + e / mPerDegLng,
    origin.lat + n / M_PER_DEG_LAT,
  ];
  return [
    pt(eastM - halfWidthM, northM - halfDepthM),
    pt(eastM + halfWidthM, northM - halfDepthM),
    pt(eastM + halfWidthM, northM + halfDepthM),
    pt(eastM - halfWidthM, northM + halfDepthM),
    pt(eastM - halfWidthM, northM - halfDepthM),
  ];
}

const CAMERA: CameraView = {
  slot: "V1",
  headingDeg: 0, // due north
  compass: "N",
  lat: 40.75,
  lng: -73.99,
  heightM: 20,
  pitchDeg: -3,
  standoffM: 20,
};

function measure(neighbors: NeighborBuilding[], eyeM = 20) {
  return assessConfidence({
    views: [CAMERA],
    eyeElevationNavd88M: eyeM,
    subjectBin: "SUBJECT",
    subjectGroundElevationNavd88M: 0,
    neighbors,
    neighborDataIncomplete: false,
  }).bySlot.V1!;
}

describe("edge sampling — a wall whose endpoints miss the cone but whose middle crosses it", () => {
  it("detects the wall", () => {
    // A 400 m slab running east-west, 50 m due north of the camera. At ±30°
    // about north the cone is only ~58 m wide at that distance, so BOTH
    // endpoints of every long edge sit far outside it. Sampling vertices only
    // would see nothing at all here.
    const wall = boxAt(CAMERA, 0, 50, 200, 5);
    const c = measure([
      { bin: "WALL", ring: wall, roofHeightM: 80, groundElevationNavd88M: 0 },
    ]);
    expect(c.firstBlockingM).not.toBeNull();
    expect(c.firstBlockingM!).toBeLessThan(50);
    expect(c.maxObstructionAngleDeg).toBeGreaterThan(45);
    expect(c.band).toBe("enclosed");
  });
});

describe("cone limits", () => {
  it("ignores a tall building outside the cone", () => {
    // Due east, well outside ±30° about north.
    const tower = boxAt(CAMERA, 100, 0, 15, 15);
    const c = measure([
      { bin: "EAST", ring: tower, roofHeightM: 200, groundElevationNavd88M: 0 },
    ]);
    expect(c.firstBlockingM).toBeNull();
    expect(c.band).toBe("open");
  });

  it("ignores a building beyond the search radius", () => {
    const far = boxAt(CAMERA, 0, SEARCH_RADIUS_M + 60, 20, 20);
    const c = measure([
      { bin: "FAR", ring: far, roofHeightM: 300, groundElevationNavd88M: 0 },
    ]);
    expect(c.firstBlockingM).toBeNull();
  });

  it("sees a building just inside the cone edge", () => {
    const angle = (CONE_HALF_ANGLE_DEG - 3) * (Math.PI / 180);
    const d = 60;
    const near = boxAt(CAMERA, Math.sin(angle) * d, Math.cos(angle) * d, 8, 8);
    const c = measure([
      { bin: "EDGE", ring: near, roofHeightM: 120, groundElevationNavd88M: 0 },
    ]);
    expect(c.firstBlockingM).not.toBeNull();
  });
});

describe("missing neighbour data", () => {
  it("falls back to the subject's ground elevation when a neighbour has none", () => {
    // Subject ground is 30 m NAVD88, eye is 40 m. A 20 m building with no
    // ground elevation on file tops out at 50 m if the fallback works, and at
    // 20 m — below the eye — if it were defaulted to zero.
    const ring = boxAt(CAMERA, 0, 40, 15, 15);
    const c = assessConfidence({
      views: [CAMERA],
      eyeElevationNavd88M: 40,
      subjectBin: "SUBJECT",
      subjectGroundElevationNavd88M: 30,
      neighbors: [
        { bin: "NOGROUND", ring, roofHeightM: 20, groundElevationNavd88M: null },
      ],
      neighborDataIncomplete: false,
    }).bySlot.V1!;
    expect(c.maxObstructionAngleDeg).toBeGreaterThan(0);
    expect(c.firstBlockingM).not.toBeNull();
  });

  it("never lets the subject building obstruct itself", () => {
    const ring = boxAt(CAMERA, 0, 30, 20, 20);
    const c = assessConfidence({
      views: [CAMERA],
      eyeElevationNavd88M: 20,
      subjectBin: "SUBJECT",
      subjectGroundElevationNavd88M: 0,
      neighbors: [
        { bin: "SUBJECT", ring, roofHeightM: 400, groundElevationNavd88M: 0 },
      ],
      neighborDataIncomplete: false,
    }).bySlot.V1!;
    expect(c.firstBlockingM).toBeNull();
    expect(c.band).toBe("open");
  });

  it("carries the incomplete flag through untouched", () => {
    const report = assessConfidence({
      views: [CAMERA],
      eyeElevationNavd88M: 20,
      subjectBin: "SUBJECT",
      subjectGroundElevationNavd88M: 0,
      neighbors: [],
      neighborDataIncomplete: true,
    });
    expect(report.neighborDataIncomplete).toBe(true);
    expect(report.neighborsConsidered).toBe(0);
  });
});

describe("the view cone tracks the renderer's real field of view", () => {
  it("is exactly half the horizontal FOV the renderer ships", () => {
    // Not a tautology worth skipping: these two numbers live in different
    // modules and used to be independent, with the cone hard-coded at 30 while
    // the frustum defaulted to 60. The moment the renderer's FOV moved, a cone
    // that did not follow would let a direction be described as open while the
    // frame visibly contained a wall.
    expect(CONE_HALF_ANGLE_DEG).toBe(RENDER_TUNING.fovDeg / 2);
  });
});

describe("a facade shared with the building next door", () => {
  // The camera sits at the local origin in every case below.
  const around = (halfWidth: number, halfDepth: number) =>
    boxAt(CAMERA, 0, 0, halfWidth, halfDepth);

  it("reports how far below the neighbour's roof the camera is embedded", () => {
    // Eye at 20 m NAVD88, a neighbour whose roof is at 60 m enclosing the
    // camera's own position: the camera is 40 m inside solid building.
    const c = measure([
      { bin: "ABUT", ring: around(15, 15), roofHeightM: 60, groundElevationNavd88M: 0 },
    ]);
    expect(c.insideNeighborByM).toBeCloseTo(40, 6);
    expect(isRenderableDirection("V1", { bySlot: { V1: c }, neighborDataIncomplete: false, neighborsConsidered: 1, searchRadiusM: SEARCH_RADIUS_M })).toBe(false);
  });

  it("does NOT fire when the camera is over a lower neighbour's roof", () => {
    // Same footprint, but the building is only 8 m tall and the eye is at 20 m.
    // Looking out across a shorter neighbour's roof is an ordinary NYC vantage,
    // not a fault, and it must keep rendering.
    const c = measure([
      { bin: "LOWER", ring: around(15, 15), roofHeightM: 8, groundElevationNavd88M: 0 },
    ]);
    expect(c.insideNeighborByM).toBeNull();
  });

  it("tolerates a roofline within the source data's own margin of error", () => {
    // Eye 20 m, neighbour roof 21 m: one metre is inside the slop of a single
    // HEIGHTROOF value for a building with parapets, so this must NOT be
    // called a party wall. At 21 m the depth is 1 m, below ABUTTING_MIN_DEPTH_M.
    const shallow = measure([
      { bin: "EDGE", ring: around(15, 15), roofHeightM: 21, groundElevationNavd88M: 0 },
    ]);
    expect(shallow.insideNeighborByM).toBeNull();

    // Three metres under is not slop.
    const real = measure([
      { bin: "EDGE", ring: around(15, 15), roofHeightM: 23, groundElevationNavd88M: 0 },
    ]);
    expect(real.insideNeighborByM).toBeCloseTo(3, 6);
  });

  it("ignores a tall neighbour that does not contain the camera", () => {
    const c = measure([
      { bin: "ACROSS", ring: boxAt(CAMERA, 0, 40, 15, 15), roofHeightM: 90, groundElevationNavd88M: 0 },
    ]);
    expect(c.insideNeighborByM).toBeNull();
    // It is still an obstruction — this rule is about placement, not enclosure.
    expect(c.band).toBe("enclosed");
  });

  it("reports the deepest containing neighbour when footprints overlap", () => {
    const c = measure([
      { bin: "A", ring: around(20, 20), roofHeightM: 30, groundElevationNavd88M: 0 },
      { bin: "B", ring: around(12, 12), roofHeightM: 70, groundElevationNavd88M: 0 },
    ]);
    expect(c.insideNeighborByM).toBeCloseTo(50, 6);
  });

  it("never fires for the subject building itself", () => {
    // The subject's own footprint contains nothing here, but the filter that
    // drops it runs before this measurement and must keep doing so — otherwise
    // every camera would be "inside" the building it belongs to whenever the
    // 6 m offset lands within its own polygon.
    const c = measure([
      { bin: "SUBJECT", ring: around(30, 30), roofHeightM: 100, groundElevationNavd88M: 0 },
    ]);
    expect(c.insideNeighborByM).toBeNull();
  });
});

describe("party walls in the real fixtures", () => {
  const inside = (raw: RawFixture, floor: number) => {
    const { views, report } = assess(raw, floor);
    return views
      .filter((v) => report.bySlot[v.slot]!.insideNeighborByM != null)
      .map((v) => v.slot);
  };

  it("finds none at the Empire State Building, the Flatiron or the Dakota", () => {
    // Three free-standing buildings. A rule that fired here would be wrong, and
    // would silently remove a direction that really does have a window.
    for (const floor of [3, 6, 8, 10, 18]) {
      expect(inside(ESB, floor)).toEqual([]);
      expect(inside(FLATIRON, floor)).toEqual([]);
      expect(inside(DAKOTA, floor)).toEqual([]);
    }
  });

  it("finds the abutting wall at 425 E 79th St, and only below the neighbour's roof", () => {
    // This is the building whose four frames the release-candidate report
    // described as "a melted grey landscape" and attributed to mesh quality.
    // One of its cameras is inside the building next door: at floor 10 the eye
    // sits 7.5 m below that neighbour's roof. The imagery was never the problem
    // in that direction — the camera placement was.
    expect(inside(E79, 10)).toEqual(["V2"]);

    const { views, report } = assess(E79, 10);
    const v2 = report.bySlot[views.find((v) => v.slot === "V2")!.slot]!;
    expect(v2.insideNeighborByM).toBeGreaterThan(5);
    expect(v2.insideNeighborByM).toBeLessThan(10);

    // Depth shrinks as the camera climbs, and the direction becomes renderable
    // again once the eye clears that neighbour's roof.
    expect(inside(E79, 3)).toContain("V2");
    expect(inside(E79, 18)).toEqual([]);
  });
});
