// The warning vocabulary, reviewed as a set.
//
// These tests are as much a review surface as a regression guard: the banned
// phrases below are the ones that would each be a claim the data does not
// support, and the sweep at the bottom checks every string this module can
// produce against all of them at once.

import { describe, it, expect } from "vitest";
import {
  LOW_VANTAGE_M,
  NO_IMAGERY_NOTE,
  RENDER_ALL_AGAIN,
  RETRY_THIS_DIRECTION,
  confidenceFor,
  directionNote,
  planNotes,
} from "./notes";
import type { ConfidenceReport, DirectionConfidence, ViewPlan } from "../lib/types";
import { buildCameraViews, estimateFloorElevation } from "../lib/geometry";
import type { BuildingFootprint } from "../lib/types";

/** ~40 m x 40 m rectangle, roof 100 m, ground 8 m. */
const footprint: BuildingFootprint = {
  bin: "1001001",
  roofHeightM: 100,
  groundElevationNavd88M: 8,
  centroid: { lat: 40.7069, lng: -74.0113 },
  ring: [
    [-74.0117, 40.7065],
    [-74.0109, 40.7065],
    [-74.0109, 40.7073],
    [-74.0117, 40.7073],
    [-74.0117, 40.7065],
  ],
};

function plan(overrides: Partial<ViewPlan> = {}, floor = 20): ViewPlan {
  const elevation = estimateFloorElevation(footprint, floor);
  const { views, basis, concentration } = buildCameraViews(
    footprint,
    elevation.eyeElevationEllipsoidalM,
    elevation.eyeElevationNavd88M - footprint.groundElevationNavd88M,
  );
  return {
    address: "11 Wall St",
    floor,
    geocode: { label: "11 WALL STREET", lat: 40.7069, lng: -74.0113, bin: "1001001" },
    footprint,
    eyeElevationNavd88M: elevation.eyeElevationNavd88M,
    eyeElevationEllipsoidalM: elevation.eyeElevationEllipsoidalM,
    geoidHeightM: elevation.geoidHeightM,
    floorClampedToRoof: elevation.clampedToRoof,
    basis,
    facadeConcentration: concentration,
    views,
    confidence: null,
    ...overrides,
  };
}

const conf = (c: Partial<DirectionConfidence>): DirectionConfidence => ({
  slot: "V1",
  band: "open",
  maxObstructionAngleDeg: -20,
  firstBlockingM: null,
  ...c,
});

describe("per-direction notes", () => {
  it("says nothing at all for an open view", () => {
    expect(directionNote(conf({ band: "open" }))).toBeNull();
  });

  it("says nothing when there is no measurement", () => {
    expect(directionNote(undefined)).toBeNull();
  });

  it("names the distance when something is very close", () => {
    const note = directionNote(
      conf({ band: "enclosed", firstBlockingM: 11.6, maxObstructionAngleDeg: 27 }),
    );
    expect(note).toBe("Another building stands about 12 m from this side.");
  });

  it("describes enclosure by angle without inventing a distance", () => {
    const note = directionNote(
      conf({ band: "enclosed", firstBlockingM: 93, maxObstructionAngleDeg: 48 }),
    );
    expect(note).toBe(
      "This side looks into nearby buildings rather than out over the city.",
    );
    expect(note).not.toMatch(/\d/);
  });

  it("has one plain sentence for partly enclosed", () => {
    expect(directionNote(conf({ band: "partly-enclosed" }))).toBe(
      "Partly enclosed — nearby rooftops fill much of this direction.",
    );
  });

  it("reports an unsettled capture as being about the capture, not the picture", () => {
    const note = directionNote(conf({ band: "open" }), { settled: false });
    expect(note).toBe("Still sharpening when this frame was captured.");
  });

  it("says nothing extra when the capture settled", () => {
    expect(directionNote(conf({ band: "open" }), { settled: true })).toBeNull();
  });
});

describe("whole-result notes", () => {
  it("is silent for an ordinary rectangular building at a normal floor", () => {
    expect(planNotes(plan({ confidence: report() }))).toEqual([]);
  });

  it("explains a clamped floor in the visitor's terms", () => {
    const p = plan({}, 400);
    expect(p.floorClampedToRoof).toBe(true);
    expect(planNotes(p).map((n) => n.text)).toContain(
      "This building is shorter than floor 400. Showing the top floor.",
    );
  });

  it("warns about a low vantage", () => {
    const p = plan({}, 2);
    const above = p.eyeElevationNavd88M - footprint.groundElevationNavd88M;
    expect(above).toBeLessThan(LOW_VANTAGE_M);
    expect(planNotes(p).map((n) => n.id)).toContain("low-vantage");
  });

  it("says the bearings are true compass when the footprint has no facades", () => {
    const notes = planNotes(plan({ basis: "compass", facadeConcentration: 0.2 }));
    expect(notes.map((n) => n.text)).toContain(
      "This footprint has no clear facades, so these are true north, east, south and west.",
    );
    // Not both — the compass note supersedes the loose-fit one.
    expect(notes.map((n) => n.id)).not.toContain("loose-facades");
  });

  it("says the four directions are a best fit when the building is not a rectangle", () => {
    const notes = planNotes(plan({ facadeConcentration: 0.6 }));
    expect(notes.map((n) => n.text)).toContain(
      "This building isn't a simple rectangle, so these four directions are a best fit to its walls.",
    );
  });

  it("admits when it could not check the surroundings", () => {
    expect(planNotes(plan({ confidence: null })).map((n) => n.id)).toContain(
      "no-neighbor-data",
    );
  });

  it("admits when some neighbours have no height on file", () => {
    const notes = planNotes(
      plan({ confidence: report({ neighborDataIncomplete: true }) }),
    );
    expect(notes.map((n) => n.text)).toContain(
      "Some nearby buildings have no height on file, so the notes below may miss an obstruction.",
    );
  });

  it("counts partial success instead of calling the result failed", () => {
    const notes = planNotes(plan({ confidence: report() }), {
      loadedCount: 2,
      totalCount: 4,
    });
    expect(notes.map((n) => n.text)).toContain("2 of 4 directions loaded.");
    expect(notes.map((n) => n.text).join(" ")).not.toMatch(/fail/i);
  });

  it("does not count when everything loaded", () => {
    const notes = planNotes(plan({ confidence: report() }), {
      loadedCount: 4,
      totalCount: 4,
    });
    expect(notes.map((n) => n.id)).not.toContain("partial");
  });

  it("does not count when nothing loaded — that is a different state entirely", () => {
    const notes = planNotes(plan({ confidence: report() }), {
      loadedCount: 0,
      totalCount: 4,
    });
    expect(notes.map((n) => n.id)).not.toContain("partial");
  });

  it("says once, at the head, that no imagery loaded at all", () => {
    const notes = planNotes(plan({ confidence: report() }), {
      loadedCount: 0,
      totalCount: 4,
      imageryUnavailable: true,
    });
    expect(notes[0].id).toBe("no-imagery");
    // States what did NOT happen, because that is the guarantee.
    expect(notes[0].text).toMatch(/nothing has been put in its place/i);
  });
});

describe("confidenceFor", () => {
  it("returns undefined when there is no report, rather than a default", () => {
    expect(confidenceFor(null, "V1")).toBeUndefined();
  });
});

describe("nothing this module can say is a claim the data doesn't support", () => {
  const BANNED = [
    /your view/i,
    /actual view/i,
    /apartment/i,
    /obstruction detected/i,
    /quality/i,
    /\d+\s*%/,
    /\bETA\b/i,
    /estimated time/i,
    // Anything implying the image itself was examined.
    /\bpixel/i,
    /\bblurr?y\b/i,
    /image analysis/i,
    /\bdetected\b/i,
    // Jargon and provider clauses have no place in visitor copy.
    /NAVD88/i,
    /WGS84/i,
    /ellipsoid/i,
    /\bgeoid\b/i,
    /\bBIN\b/,
    /§/,
    /Terms of Service/i,
    /Map Tiles/i,
  ];

  const everyString = (): string[] => {
    const out: string[] = [];
    for (const band of ["open", "partly-enclosed", "enclosed"] as const) {
      for (const first of [null, 11.6, 93]) {
        const n = directionNote(
          conf({ band, firstBlockingM: first, maxObstructionAngleDeg: 48 }),
        );
        if (n) out.push(n);
      }
    }
    const unsettled = directionNote(conf({}), { settled: false });
    if (unsettled) out.push(unsettled);

    for (const p of [
      plan({ confidence: null }, 2),
      plan({ confidence: report({ neighborDataIncomplete: true }) }, 400),
      plan({ basis: "compass", facadeConcentration: 0.2, confidence: report() }),
      plan({ facadeConcentration: 0.6, confidence: report() }),
    ]) {
      out.push(...planNotes(p, { loadedCount: 3, totalCount: 4 }).map((n) => n.text));
    }
    out.push(
      ...planNotes(plan({ confidence: report() }), {
        imageryUnavailable: true,
      }).map((n) => n.text),
      NO_IMAGERY_NOTE,
      RETRY_THIS_DIRECTION,
      RENDER_ALL_AGAIN,
    );
    return out;
  };

  it("passes the banned-phrase sweep", () => {
    const strings = everyString();
    expect(strings.length).toBeGreaterThan(8);
    for (const s of strings) {
      for (const pattern of BANNED) {
        expect(s, `"${s}" matched ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("keeps every note to a single short sentence", () => {
    for (const s of everyString()) {
      expect(s.length, s).toBeLessThan(110);
    }
  });
});

function report(overrides: Partial<ConfidenceReport> = {}): ConfidenceReport {
  return {
    bySlot: {},
    neighborDataIncomplete: false,
    neighborsConsidered: 12,
    searchRadiusM: 220,
    ...overrides,
  };
}
