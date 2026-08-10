// The geometry class of a direction, and the one thing that is allowed to
// depend on it.
//
// Offline throughout: the real cases run against committed NYC Open Data
// footprints, and no provider endpoint or imagery is involved. That is the
// point of the layer — a classification that needed a render to produce would
// be a classification that could change when a render did.

import { describe, expect, it } from "vitest";
import {
  classifyDirection,
  isCaptureRequested,
  isDirectionRequested,
  MEASURED_CLASSES,
  type DirectionClass,
} from "./directionClass";
import { assessConfidence } from "./confidence";
import { loadCase, type RawFixture } from "./__fixtures__/loader";
import { VIEW_SLOTS } from "./types";
import type { ConfidenceReport, DirectionConfidence, ViewSlot } from "./types";
import e79Raw from "./__fixtures__/e79.json";

const E79 = e79Raw as unknown as RawFixture;

function assess(raw: RawFixture, floor: number): ConfidenceReport {
  const c = loadCase(raw, floor);
  return assessConfidence({
    views: c.views,
    eyeElevationNavd88M: c.eyeElevationNavd88M,
    subjectBin: c.bin,
    subjectGroundElevationNavd88M: c.footprint.groundElevationNavd88M,
    neighbors: c.neighbors,
    neighborDataIncomplete: c.neighborDataIncomplete,
  });
}

function direction(
  slot: ViewSlot,
  d: Partial<DirectionConfidence>,
): DirectionConfidence {
  return {
    slot,
    band: "open",
    maxObstructionAngleDeg: -20,
    firstBlockingM: null,
    insideNeighborByM: null,
    courtWidthM: null,
    ...d,
  };
}

const report = (d: Partial<DirectionConfidence>): ConfidenceReport => ({
  bySlot: { V1: direction("V1", d) },
  neighborDataIncomplete: false,
  neighborsConsidered: 12,
  searchRadiusM: 220,
});

describe("how a direction is classified", () => {
  it("marks a light court as close range rather than as a bad view", () => {
    expect(classifyDirection("V1", report({ courtWidthM: 4.4, band: "enclosed" }))).toBe(
      "close",
    );
  });

  it("marks a wall inside the neighbour as having no window", () => {
    expect(classifyDirection("V1", report({ insideNeighborByM: 8 }))).toBe(
      "no-window",
    );
  });

  it("separates close range from merely enclosed", () => {
    expect(classifyDirection("V1", report({ band: "enclosed" }))).toBe("qualified");
    expect(classifyDirection("V1", report({ band: "partly-enclosed" }))).toBe("open");
    expect(classifyDirection("V1", report({ band: "open" }))).toBe("open");
  });

  // A court under about three metres has no camera position that clears both
  // walls, so the renderer never asks for it. Calling that "close range" left
  // an empty pane announcing that it was waiting to capture, under a note
  // describing a picture that was never coming. Two buildings in the acceptance
  // matrix hit it: 432 Park at floor 3 and 63 Bedford St.
  it("separates a court a camera fits in from one it does not", () => {
    expect(classifyDirection("V1", report({ courtWidthM: 4.4 }))).toBe("close");
    expect(classifyDirection("V1", report({ courtWidthM: 2 }))).toBe("no-room");
    expect(classifyDirection("V1", report({ courtWidthM: 0.4 }))).toBe("no-room");
  });
});

describe("an absent measurement is not a measurement of nothing", () => {
  // THE CASE THAT USED TO FLIP.
  //
  // 425 E 79th St is a row building whose WNW facade is inside the building
  // next door: the arithmetic over the committed footprints says `no-window`,
  // and it says so at every floor below the neighbour's roof, on every run,
  // forever. It is a fact about the block.
  //
  // The neighbour lookup that produces that arithmetic is best-effort — it gets
  // a bounded window and the plan ships without it when NYC Open Data is slow
  // (planView.NEIGHBOR_TIMEOUT_MS). When it did not arrive, every direction was
  // classified `normal`: the identical value a direction gets when the
  // neighbours WERE measured and nothing stands in the way. So the same address
  // at the same floor was classified one way on a fast response and another way
  // on a slow one, the party wall was requested from the provider like any
  // other side, and the frame that came back — the inside of a neighbouring
  // mesh — was presented with no qualification at all.
  //
  // These two tests are the fix: the measured class is stable, and the absence
  // is its own class rather than a value that means something else.
  const measured = assess(E79, 4);

  it("classifies the party wall at 425 E 79th St from the footprints", () => {
    expect(classifyDirection("V4", measured)).toBe("no-window");
    expect(isDirectionRequested("V4", measured)).toBe(false);
    expect(classifyDirection("V2", measured)).toBe("close");
  });

  it("never produces a measured class without a measurement", () => {
    for (const slot of VIEW_SLOTS) {
      expect(classifyDirection(slot, null)).toBe("unmeasured");
      expect(classifyDirection(slot, undefined)).toBe("unmeasured");
      expect(MEASURED_CLASSES).not.toContain(classifyDirection(slot, null));
    }
    // Specifically: not the same answer as a direction that WAS measured and
    // found open. Those two must be tellable apart, because one of them is a
    // statement about the building and the other is a statement about a
    // network request.
    expect(classifyDirection("V1", null)).not.toBe(
      classifyDirection("V1", report({ band: "open" })),
    );
  });

  it("treats a report with no row for the slot the same as no report", () => {
    // A report that came back short is an absent measurement for the missing
    // directions, not an open view for them.
    expect(classifyDirection("V4", report({ band: "open" }))).toBe("unmeasured");
  });

  it("still asks the provider for a direction it could not measure", () => {
    // Not knowing what is on that side is not a reason to refuse to look at it.
    // The result says the surroundings could not be checked.
    expect(isDirectionRequested("V3", null)).toBe(true);
  });
});

describe("classification is geometry, availability is derived from it", () => {
  const cases: Array<Partial<DirectionConfidence>> = [
    { courtWidthM: 0.4 },
    { courtWidthM: 2 },
    { courtWidthM: 3 },
    { courtWidthM: 4.4 },
    { courtWidthM: 12 },
    { insideNeighborByM: 8 },
    { band: "enclosed" as const },
    { band: "partly-enclosed" as const },
    { band: "open" as const },
  ];

  it("gives the same answer however many times it is asked", () => {
    for (const d of cases) {
      const r = report(d);
      const first = classifyDirection("V1", r);
      for (let i = 0; i < 20; i += 1) {
        expect(classifyDirection("V1", r), JSON.stringify(d)).toBe(first);
      }
    }
  });

  it("decides what is requested from the class and nothing else", () => {
    // The label and the renderer cannot disagree, because there is only one
    // decision: the class. `isCaptureRequested` takes a class, not a slot and a
    // report, so there is no second path to the answer for the two to differ on.
    for (const d of cases) {
      const r = report(d);
      expect(isDirectionRequested("V1", r), JSON.stringify(d)).toBe(
        isCaptureRequested(classifyDirection("V1", r)),
      );
    }
  });

  it("refuses a capture for exactly the two classes with nothing to photograph", () => {
    const all: DirectionClass[] = [
      "open",
      "qualified",
      "close",
      "no-room",
      "no-window",
      "unmeasured",
    ];
    expect(all.filter((c) => !isCaptureRequested(c))).toEqual([
      "no-room",
      "no-window",
    ]);
  });
});
