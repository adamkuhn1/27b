// The warning vocabulary, reviewed as a set.
//
// These tests are as much a review surface as a regression guard: the banned
// phrases below are the ones that would each be a claim the data does not
// support, and the sweep at the bottom checks every string this module can
// produce against all of them at once.

import { describe, it, expect } from "vitest";
import {
  ABUTTING_NOTE,
  LOW_VANTAGE_M,
  NO_IMAGERY_NOTE,
  RENDER_ALL_AGAIN,
  RETRY_THIS_DIRECTION,
  confidenceFor,
  directionNote,
  planNotes,
  qualityLead,
  renderStateLabel,
} from "./notes";
import type { DirectionClass } from "../lib/directionClass";
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
  insideNeighborByM: null,
  courtWidthM: null,
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

describe("a slow capture of an obstructed direction", () => {
  // A returning visitor on a slow connection gets pixel-identical frames and a
  // longer settle. The building next door is exactly as close either way, so
  // the settle state must not be able to spend the sentence the measurement
  // needs. Recorded at 425 E 79th St floor 4 NNE, where a 60.8 s pass and a
  // 24.5 s pass produced identical pixels and different notes.
  const enclosed = conf({
    band: "enclosed",
    firstBlockingM: 11.6,
    maxObstructionAngleDeg: 27,
  });

  it("still names the distance to the building on that side", () => {
    const note = directionNote(enclosed, { settled: false });
    expect(note).toContain("Another building stands about 12 m from this side");
  });

  it("reports the slow settle as well, in the same sentence", () => {
    expect(directionNote(enclosed, { settled: false })).toBe(
      "Another building stands about 12 m from this side; this frame was still sharpening.",
    );
  });

  it("does not lose the enclosure statement that carries no distance", () => {
    expect(
      directionNote(
        conf({ band: "enclosed", firstBlockingM: 93, maxObstructionAngleDeg: 48 }),
        { settled: false },
      ),
    ).toBe(
      "This side looks into nearby buildings rather than out over the city; this frame was still sharpening.",
    );
  });

  it("does not lose a partly-enclosed direction either", () => {
    expect(directionNote(conf({ band: "partly-enclosed" }), { settled: false })).toBe(
      "Partly enclosed — nearby rooftops fill much of this direction; this frame was still sharpening.",
    );
  });

  it("says the same thing about the world whether the capture was slow or not", () => {
    for (const c of [
      conf({ band: "enclosed", firstBlockingM: 11.6, maxObstructionAngleDeg: 27 }),
      conf({ band: "enclosed", firstBlockingM: 93, maxObstructionAngleDeg: 48 }),
      conf({ band: "partly-enclosed" }),
    ]) {
      const settled = directionNote(c, { settled: true })!;
      const unsettled = directionNote(c, { settled: false })!;
      expect(unsettled).toContain(settled.replace(/\.$/, ""));
    }
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

  it("counts up while frames are still arriving", () => {
    const notes = planNotes(plan({ confidence: report() }), {
      loadedCount: 2,
      totalCount: 4,
      stillCapturing: true,
    });
    expect(notes.map((n) => n.text)).toContain("2 of 4 directions loaded.");
  });

  it("says what the empty frames are once the render is over", () => {
    // The bare count left two empty frames unexplained, which is the state a
    // reader most needs a sentence for.
    const [note] = planNotes(plan({ confidence: report() }), {
      loadedCount: 2,
      totalCount: 4,
      stillCapturing: false,
    }).filter((n) => n.id === "partial");
    expect(note.text).toContain("2 of 4 directions loaded");
    expect(note.text).toMatch(/the other 2 frames are empty, not stand-ins/);
    expect(note.text).not.toMatch(/fail/i);
  });

  it("keeps the singular readable when only one direction is missing", () => {
    const [note] = planNotes(plan({ confidence: report() }), {
      loadedCount: 3,
      totalCount: 4,
      stillCapturing: false,
    }).filter((n) => n.id === "partial");
    expect(note.text).toMatch(/the other frame is empty, not a stand-in/);
  });

  it("does not go silent when a render opened and produced nothing", () => {
    // Distinct from `imageryUnavailable`, which is a session that never opened,
    // and from the still-capturing case, where zero loaded means "not yet".
    const notes = planNotes(plan({ confidence: report() }), {
      loadedCount: 0,
      totalCount: 4,
      stillCapturing: false,
    });
    expect(notes.map((n) => n.id)).toContain("none-loaded");
    expect(notes.find((n) => n.id === "none-loaded")!.text).toMatch(
      /nothing has been put in its place/i,
    );
  });

  it("stays silent about counts when there is no render at all", () => {
    // No imagery key: the page says so in its own state, and a note claiming
    // nothing loaded would be describing a render that was never requested.
    const notes = planNotes(plan({ confidence: report() }), {
      loadedCount: 0,
      totalCount: 4,
      stillCapturing: undefined,
    });
    expect(notes.map((n) => n.id)).not.toContain("none-loaded");
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
        // Both settle states: an unsettled capture of an obstructed direction
        // carries the measurement AND the settle clause in one sentence, and
        // that longer sentence is held to the same length as the short ones.
        for (const settled of [undefined, true, false]) {
          // ...and both load states: a direction whose frame never arrived
          // keeps its measurement and adds a sentence, so the composed string
          // is held to the same length as the short ones.
          for (const didNotLoad of [false, true]) {
            const n = directionNote(
              conf({ band, firstBlockingM: first, maxObstructionAngleDeg: 48 }),
              { settled, didNotLoad },
            );
            if (n) out.push(n);
          }
        }
      }
    }
    const unsettled = directionNote(conf({}), { settled: false });
    if (unsettled) out.push(unsettled);

    // Both halves of the light-court copy: the court a camera fits in, and the
    // one it does not. Widths chosen to reach both branches of the rounding.
    for (const courtWidthM of [4.4, 2, 0.4]) {
      for (const capturable of [true, false]) {
        const n = directionNote(conf({ courtWidthM }), { capturable });
        if (n) out.push(n);
      }
    }

    for (const p of [
      plan({ confidence: null }, 2),
      plan({ confidence: report({ neighborDataIncomplete: true }) }, 400),
      plan({ basis: "compass", facadeConcentration: 0.2, confidence: report() }),
      plan({ facadeConcentration: 0.6, confidence: report() }),
    ]) {
      out.push(...planNotes(p, { loadedCount: 3, totalCount: 4 }).map((n) => n.text));
    }
    // Every form the load-count note can take, including the ones only a
    // finished render produces. A string that reaches the screen and not this
    // list is a string nothing checks.
    for (const [loadedCount, stillCapturing] of [
      [2, false],
      [3, false],
      [1, true],
      [0, false],
    ] as const) {
      out.push(
        ...planNotes(plan({ confidence: report() }), {
          loadedCount,
          totalCount: 4,
          stillCapturing,
        }).map((n) => n.text),
      );
    }
    out.push(
      ...planNotes(plan({ confidence: report() }), {
        imageryUnavailable: true,
      }).map((n) => n.text),
      NO_IMAGERY_NOTE,
      ABUTTING_NOTE,
      RETRY_THIS_DIRECTION,
      RENDER_ALL_AGAIN,
    );
    // The running-progress note, and every word the app can write inside an
    // empty frame or beside a direction's label. A string that reaches the
    // screen and not this list is a string nothing checks.
    out.push(
      ...planNotes(plan({ confidence: report() }), {
        loadedCount: 0,
        totalCount: 4,
        stillCapturing: true,
      }).map((n) => n.text),
      ...planNotes(plan({ confidence: report() }), {
        loadedCount: 0,
        totalCount: 1,
        stillCapturing: true,
      }).map((n) => n.text),
    );
    const CLASSES: DirectionClass[] = [
      "open",
      "qualified",
      "close",
      "no-room",
      "no-window",
      "unmeasured",
    ];
    for (const cls of CLASSES) {
      const lead = qualityLead(cls);
      if (lead) out.push(lead);
      for (const state of [
        "not-requested",
        "queued",
        "capturing",
        "ready",
        "failed",
      ] as const) {
        const label = renderStateLabel(state, cls);
        if (label) out.push(label);
      }
    }
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

describe("a light court", () => {
  it("says the width and that the building opposite is close", () => {
    expect(directionNote(conf({ courtWidthM: 4.4 }))).toBe(
      "A light court about 4 m wide \u2014 the building opposite is very close.",
    );
  });

  it("says instead that there is no frame when a camera does not fit", () => {
    // The direction is never requested, so the pane beside this sentence is
    // empty for good. Saying "the building opposite is very close" there would
    // describe a picture that does not exist.
    const note = directionNote(conf({ courtWidthM: 2 }), { capturable: false });
    expect(note).toBe(
      "A light court about 2 m wide \u2014 too narrow to place a camera in, so this side has no frame.",
    );
  });

  it("never rounds a real gap down to zero metres", () => {
    // NYC footprints are not surveyed better than a metre, so widths round to
    // one — but "about 0 m wide" reads as a bug rather than as a measurement.
    expect(directionNote(conf({ courtWidthM: 0.4 }), { capturable: false })).toContain(
      "under a metre wide",
    );
    expect(directionNote(conf({ courtWidthM: 0.4 }))).toContain("under a metre wide");
  });
});

describe("a wall shared with the building next door", () => {
  it("says there is no window there, and says it instead of an enclosure note", () => {
    // The enclosure fields are populated and would otherwise produce "another
    // building stands about 9 m from this side" — true, but beside the point
    // when the wall in question has no window in it at all.
    expect(
      directionNote(conf({ band: "enclosed", firstBlockingM: 9, insideNeighborByM: 21 })),
    ).toBe(ABUTTING_NOTE);
  });

  it("outranks the still-sharpening note, because nothing was ever captured", () => {
    expect(
      directionNote(conf({ insideNeighborByM: 40 }), { settled: false }),
    ).toBe(ABUTTING_NOTE);
  });

  it("never appears for an ordinary direction", () => {
    expect(directionNote(conf({ band: "open" }))).toBeNull();
    expect(directionNote(conf({ band: "enclosed", firstBlockingM: 9 }))).not.toBe(
      ABUTTING_NOTE,
    );
  });
});


describe("a direction that did not load keeps what was measured about it", () => {
  // The measurement is a fact about the building and is exactly as true when
  // the frame is missing. Saying only "this direction didn't load" spends the
  // one line available on the renderer and throws away the answer the reader
  // came for.
  const enclosed = conf({
    band: "enclosed",
    firstBlockingM: 11.6,
    maxObstructionAngleDeg: 27,
  });

  it("still names the distance to the building on that side", () => {
    expect(directionNote(enclosed, { didNotLoad: true })).toBe(
      "Another building stands about 12 m from this side. This direction didn't load.",
    );
  });

  it("says the frame is missing when there was nothing else to say", () => {
    expect(directionNote(undefined, { didNotLoad: true })).toBe(NO_IMAGERY_NOTE);
  });

  it("keeps the light-court measurement too", () => {
    expect(directionNote(conf({ courtWidthM: 4.4 }), { didNotLoad: true })).toContain(
      "A light court about 4 m wide",
    );
  });

  it("says the same thing about the world whether the frame arrived or not", () => {
    for (const c of [
      enclosed,
      conf({ band: "enclosed", firstBlockingM: 93, maxObstructionAngleDeg: 48 }),
      conf({ band: "partly-enclosed" }),
      conf({ insideNeighborByM: 8 }),
    ]) {
      const loaded = directionNote(c)!;
      const missing = directionNote(c, { didNotLoad: true })!;
      expect(missing).toContain(loaded);
    }
  });

  it("does not also report a settle state for a frame that does not exist", () => {
    expect(
      directionNote(enclosed, { didNotLoad: true, settled: false }),
    ).not.toMatch(/sharpening/i);
  });
});

describe("what the app says while it is still capturing", () => {
  it("says something rather than nothing before the first frame lands", () => {
    // Four empty frames and no sentence is indistinguishable from a broken
    // render, and the first frame of a session can take the better part of a
    // minute.
    const notes = planNotes(plan({ confidence: report() }), {
      loadedCount: 0,
      totalCount: 4,
      stillCapturing: true,
    });
    expect(notes.map((n) => n.id)).toContain("capturing");
    expect(notes.find((n) => n.id === "capturing")!.text).toBe(
      "Capturing 4 directions now. Each one appears as it arrives.",
    );
  });

  it("counts the directions actually requested, not always four", () => {
    const notes = planNotes(plan({ confidence: report() }), {
      loadedCount: 0,
      totalCount: 2,
      stillCapturing: true,
    });
    expect(notes.find((n) => n.id === "capturing")!.text).toContain(
      "Capturing 2 directions",
    );
  });

  it("stops saying it once a frame has landed", () => {
    const notes = planNotes(plan({ confidence: report() }), {
      loadedCount: 1,
      totalCount: 4,
      stillCapturing: true,
    });
    expect(notes.map((n) => n.id)).not.toContain("capturing");
    expect(notes.map((n) => n.id)).toContain("partial");
  });

  it("says nothing about capturing when there is no render at all", () => {
    expect(
      planNotes(plan({ confidence: report() }), {
        loadedCount: 0,
        totalCount: 4,
        stillCapturing: undefined,
      }).map((n) => n.id),
    ).not.toContain("capturing");
  });
});

describe("every direction state has words for the empty frame", () => {
  it("names each state a visitor can be looking at", () => {
    expect(renderStateLabel("queued", "open")).toBe("Waiting to capture");
    expect(renderStateLabel("capturing", "open")).toBe("Capturing");
    expect(renderStateLabel("failed", "open")).toBe("Didn't load");
    // A frame that exists needs no words over it.
    expect(renderStateLabel("ready", "open")).toBeNull();
  });

  it("distinguishes the two reasons a direction was never requested", () => {
    expect(renderStateLabel("not-requested", "no-window")).toBe("No window");
    expect(renderStateLabel("not-requested", "no-room")).toBe(
      "No frame on this side",
    );
  });

  it("tells an unchecked direction apart from a measured open one", () => {
    // Presenting them identically is what let a slow open-data response pass a
    // party wall off as an ordinary view.
    expect(qualityLead("open")).toBeNull();
    expect(qualityLead("unmeasured")).toBe("Surroundings not checked");
  });
});
