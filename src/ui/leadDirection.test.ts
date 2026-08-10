import { describe, expect, it } from "vitest";
import { captureOrder, chooseLeadDirection } from "./leadDirection";
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

describe("the order the four directions are asked for", () => {
  // The reveal is progressive, so the direction shown large should be the one
  // captured first. It used to be captured in plan order, which meant the hero
  // frame could be the fourth to land — a large empty rectangle held on screen
  // for the whole session while the three thumbnails beside it filled in.
  it("asks for the direction it opens on first", () => {
    const p = plan({
      V1: { band: "enclosed", firstBlockingM: 10 },
      V2: { band: "enclosed", firstBlockingM: 12 },
      V3: { band: "open", firstBlockingM: null },
      V4: { band: "partly-enclosed", firstBlockingM: 40 },
    });
    expect(captureOrder(p)[0].slot).toBe(chooseLeadDirection(p));
    expect(captureOrder(p).map((v) => v.slot)).toEqual(["V3", "V4", "V2", "V1"]);
  });

  it("never asks for a direction nothing can be captured for", () => {
    const p = plan({
      V1: { insideNeighborByM: 8 },
      V2: { courtWidthM: 2 },
      V3: { band: "open" },
      V4: { band: "enclosed", firstBlockingM: 9 },
    });
    expect(captureOrder(p).map((v) => v.slot)).toEqual(["V3", "V4"]);
  });

  it("is the same order every time, including when nothing is measured", () => {
    for (const p of [
      plan(null),
      plan({
        V1: { band: "open", firstBlockingM: null },
        V2: { band: "open", firstBlockingM: null },
        V3: { band: "open", firstBlockingM: null },
        V4: { band: "open", firstBlockingM: null },
      }),
    ]) {
      const first = captureOrder(p).map((v) => v.slot);
      for (let i = 0; i < 5; i += 1) {
        expect(captureOrder(p).map((v) => v.slot)).toEqual(first);
      }
      // Everything equal: plan order, not whatever the engine felt like.
      expect(first).toEqual(["V1", "V2", "V3", "V4"]);
    }
  });

  it("keeps every requested direction, in one pass", () => {
    const p = plan({
      V1: { band: "enclosed", firstBlockingM: 10 },
      V2: { courtWidthM: 4.4 },
      V3: { band: "open", firstBlockingM: 300 },
      V4: { band: "partly-enclosed", firstBlockingM: 45 },
    });
    const order = captureOrder(p);
    expect(new Set(order.map((v) => v.slot)).size).toBe(order.length);
    expect(order.length).toBe(4);
  });
});
