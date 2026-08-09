import { describe, expect, it } from "vitest";
import { chooseLeadDirection, isUncaptured, viewQuality } from "./leadDirection";
import { isRenderableDirection } from "../lib/confidence";
import type {
  CameraView,
  ConfidenceReport,
  DirectionConfidence,
  ViewPlan,
  ViewSlot,
} from "../lib/types";

const SLOTS: ViewSlot[] = ["V1", "V2", "V3", "V4"];

function view(slot: ViewSlot, headingDeg: number): CameraView {
  return {
    slot,
    headingDeg,
    compass: "N",
    lat: 40.7,
    lng: -74,
    heightM: 60,
    pitchDeg: -3,
    standoffM: 26,
    wallDistanceM: 20,
  };
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

function plan(
  bySlot: Partial<Record<ViewSlot, Partial<DirectionConfidence>>> | null,
): ViewPlan {
  const confidence: ConfidenceReport | null = bySlot
    ? {
        bySlot: Object.fromEntries(
          Object.entries(bySlot).map(([slot, d]) => [
            slot,
            direction(slot as ViewSlot, d!),
          ]),
        ),
        neighborDataIncomplete: false,
        neighborsConsidered: 12,
        searchRadiusM: 220,
      }
    : null;

  return {
    views: SLOTS.map((s, i) => view(s, i * 90)),
    confidence,
  } as unknown as ViewPlan;
}

describe("choosing the direction to show large", () => {
  it("prefers an open direction over an enclosed one", () => {
    expect(
      chooseLeadDirection(
        plan({
          V1: { band: "enclosed", firstBlockingM: 10 },
          V2: { band: "enclosed", firstBlockingM: 12 },
          V3: { band: "open", firstBlockingM: null },
          V4: { band: "partly-enclosed", firstBlockingM: 40 },
        }),
      ),
    ).toBe("V3");
  });

  it("prefers partly-enclosed over enclosed when nothing is open", () => {
    expect(
      chooseLeadDirection(
        plan({
          V1: { band: "enclosed", firstBlockingM: 8 },
          V2: { band: "partly-enclosed", firstBlockingM: 40 },
          V3: { band: "enclosed", firstBlockingM: 9 },
          V4: { band: "enclosed", firstBlockingM: 11 },
        }),
      ),
    ).toBe("V2");
  });

  it("breaks a tie on the distance to the nearest obstruction", () => {
    expect(
      chooseLeadDirection(
        plan({
          V1: { band: "open", firstBlockingM: 80 },
          V2: { band: "open", firstBlockingM: 200 },
          V3: { band: "open", firstBlockingM: 95 },
          V4: { band: "open", firstBlockingM: 61 },
        }),
      ),
    ).toBe("V2");
    // Nothing obstructing at all beats any finite distance.
    expect(
      chooseLeadDirection(
        plan({
          V1: { band: "open", firstBlockingM: 200 },
          V2: { band: "open", firstBlockingM: null },
          V3: { band: "open", firstBlockingM: 90 },
          V4: { band: "open", firstBlockingM: 70 },
        }),
      ),
    ).toBe("V2");
  });

  it("never opens on a light court, even when it is the least enclosed", () => {
    // A camera standing 2 m off the wall opposite is not the frame to lead
    // with, however its band works out. This is the presentation half of the
    // party-wall fix: the direction is captured and reachable, but it does not
    // get to be the first thing you see.
    expect(
      chooseLeadDirection(
        plan({
          V1: { band: "open", courtWidthM: 4.4, firstBlockingM: 400 },
          V2: { band: "enclosed", firstBlockingM: 15 },
          V3: { band: "enclosed", firstBlockingM: 12 },
          V4: { insideNeighborByM: 8 },
        }),
      ),
    ).toBe("V2");
  });

  it("never opens on a direction with no window", () => {
    const chosen = chooseLeadDirection(
      plan({
        V1: { insideNeighborByM: 9 },
        V2: { insideNeighborByM: 7 },
        V3: { band: "enclosed", firstBlockingM: 6 },
        V4: { insideNeighborByM: 5 },
      }),
    );
    expect(chosen).toBe("V3");
  });

  it("returns null when the building has no direction to show", () => {
    expect(
      chooseLeadDirection(
        plan({
          V1: { insideNeighborByM: 9 },
          V2: { insideNeighborByM: 7 },
          V3: { insideNeighborByM: 6 },
          V4: { insideNeighborByM: 5 },
        }),
      ),
    ).toBeNull();
  });

  it("does not treat missing enclosure data as a bad direction", () => {
    // No neighbour data is an unmeasured direction, not an enclosed one.
    // Ranking absence worst would hand the lead to a measured-enclosed
    // direction on the strength of knowing nothing about the other.
    expect(chooseLeadDirection(plan(null))).toBe("V1");
    expect(
      chooseLeadDirection(
        plan({
          V2: { band: "enclosed", firstBlockingM: 8 },
          V3: { band: "enclosed", firstBlockingM: 9 },
          V4: { band: "enclosed", firstBlockingM: 10 },
        }),
      ),
    ).toBe("V1");
  });

  it("is deterministic for the same plan", () => {
    const p = plan({
      V1: { band: "open", firstBlockingM: 100 },
      V2: { band: "open", firstBlockingM: 100 },
      V3: { band: "open", firstBlockingM: 100 },
      V4: { band: "open", firstBlockingM: 100 },
    });
    const first = chooseLeadDirection(p);
    for (let i = 0; i < 5; i++) expect(chooseLeadDirection(p)).toBe(first);
    // All equal: plan order decides, so the choice does not wander.
    expect(first).toBe("V1");
  });
});

describe("how a direction is presented", () => {
  const report = (d: Partial<DirectionConfidence>): ConfidenceReport =>
    plan({ V1: d }).confidence!;

  it("marks a light court as close range rather than as a bad view", () => {
    expect(viewQuality("V1", report({ courtWidthM: 4.4, band: "enclosed" }))).toBe(
      "close",
    );
  });

  it("marks a wall inside the neighbour as having no window", () => {
    expect(viewQuality("V1", report({ insideNeighborByM: 8 }))).toBe("no-window");
  });

  it("separates close range from merely enclosed", () => {
    expect(viewQuality("V1", report({ band: "enclosed" }))).toBe("qualified");
    expect(viewQuality("V1", report({ band: "partly-enclosed" }))).toBe("normal");
    expect(viewQuality("V1", report({ band: "open" }))).toBe("normal");
  });

  it("says nothing about a direction it has no data for", () => {
    expect(viewQuality("V1", null)).toBe("normal");
    expect(viewQuality("V4", report({ band: "enclosed" }))).toBe("normal");
  });

  // A court under about three metres has no camera position that clears both
  // walls, so the renderer never asks for it. Calling that "close range" — as
  // this did — left an empty pane announcing that it was waiting to capture,
  // under a note describing a picture that was never coming. Two buildings in
  // the acceptance matrix hit it: 432 Park at floor 3 and 63 Bedford St.
  it("separates a court a camera fits in from one it does not", () => {
    expect(viewQuality("V1", report({ courtWidthM: 4.4 }))).toBe("close");
    expect(viewQuality("V1", report({ courtWidthM: 2 }))).toBe("no-room");
    expect(viewQuality("V1", report({ courtWidthM: 0.4 }))).toBe("no-room");
  });

  it("agrees with the predicate that decides what is requested", () => {
    // The label and the renderer must not be able to disagree: anything the
    // renderer skips has to be presented as a direction with no frame.
    for (const d of [
      { courtWidthM: 0.4 },
      { courtWidthM: 2 },
      { courtWidthM: 3 },
      { courtWidthM: 4.4 },
      { courtWidthM: 12 },
      { insideNeighborByM: 8 },
      { band: "enclosed" as const },
      { band: "open" as const },
    ]) {
      const r = report(d);
      expect(isUncaptured(viewQuality("V1", r)), JSON.stringify(d)).toBe(
        !isRenderableDirection("V1", r),
      );
    }
  });
});
