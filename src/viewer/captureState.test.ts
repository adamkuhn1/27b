// What the UI holds for each direction, as an event sequence is folded into it.
//
// No React, no Cesium, no key: `applyCaptureEvent` and `concludeUnfinished` are
// the whole of the state machine, and the rules that matter here are about
// sequences — what a LATER event is allowed to do to what an EARLIER one
// established — which is exactly what a reducer can be driven through and a
// rendered component cannot be, cheaply.

import { describe, expect, it } from "vitest";
import {
  applyCaptureEvent,
  concludeUnfinished,
  readyCount,
  requestedCount,
  type SlotState,
} from "./useTileCaptures";
import type { CaptureEvent, ViewSlot } from "../lib/types";

/** A 1x1 transparent PNG: real bytes, produced here, standing in for a frame. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const started = (slot: ViewSlot, attempt = 1): CaptureEvent => ({
  kind: "view-started",
  slot,
  attempt,
});

const captured = (
  slot: ViewSlot,
  attempt = 1,
  settled = true,
): CaptureEvent => ({
  kind: "view-captured",
  result: { slot, dataUrl: PNG, attribution: ["Google", `Vexcel ${slot}`] },
  settled,
  elapsedMs: 12_000,
  attempt,
});

const failed = (
  slot: ViewSlot,
  attempt = 1,
  willRetry = false,
): CaptureEvent => ({
  kind: "view-failed",
  slot,
  failure: {
    kind: "capture-failed",
    detail: `Direction ${slot} did not return within 60000 ms (attempt ${attempt}).`,
    fatalForSession: false,
  },
  attempt,
  willRetry,
});

const seeded = (): Record<string, SlotState> => ({
  V1: { phase: "queued", attempts: 0 },
  V2: { phase: "queued", attempts: 0 },
  V3: { phase: "queued", attempts: 0 },
  V4: { phase: "not-requested", attempts: 0 },
});

const fold = (events: CaptureEvent[]) =>
  events.reduce(applyCaptureEvent, seeded() as ReturnType<typeof seeded>);

describe("a frame that arrived is never taken away again", () => {
  // The failure that motivates this is ordinary rather than exotic: a capture
  // is abandoned on its deadline, or a reader spends a manual attempt on a
  // direction they thought looked soft, and the attempt fails. Before this, the
  // failure handler replaced the whole slot — so a pane that had been showing a
  // real photograph of the city went empty and started saying it did not load.
  it("keeps the picture when a later attempt at the same direction times out", () => {
    const after = fold([
      started("V1"),
      captured("V1"),
      started("V1", 2),
      failed("V1", 2),
    ]);
    expect(after.V1.phase).toBe("ready");
    expect(after.V1.dataUrl).toBe(PNG);
    expect(readyCount(after)).toBe(1);
  });

  it("keeps the picture on screen while the re-capture is running", () => {
    const after = fold([started("V1"), captured("V1"), started("V1", 2)]);
    expect(after.V1.phase).toBe("ready");
    expect(after.V1.dataUrl).toBe(PNG);
    expect(after.V1.recapturing).toBe(true);
  });

  it("keeps the settle state that came with the frame, not the failed attempt's", () => {
    // `settled` is a statement about the capture that produced the frame on
    // screen. An abandoned later attempt has no frame and therefore no settle
    // state to contribute; overwriting with `undefined` would silently drop the
    // "still sharpening" qualification from a frame that carries it.
    const after = fold([
      started("V1"),
      captured("V1", 1, false),
      started("V1", 2),
      failed("V1", 2),
    ]);
    expect(after.V1.settled).toBe(false);
  });

  it("keeps every earlier frame when the session ends with others outstanding", () => {
    const after = concludeUnfinished(
      fold([started("V1"), captured("V1"), started("V2")]),
    );
    expect(after.V1).toMatchObject({ phase: "ready", dataUrl: PNG });
    // The one still in flight when time ran out is reported as not loaded, once.
    expect(after.V2!.phase).toBe("failed");
    expect(after.V3!.phase).toBe("failed");
  });

  it("does not turn a direction nothing was asked for into a failure", () => {
    const after = concludeUnfinished(fold([]));
    expect(after.V4!.phase).toBe("not-requested");
  });

  it("records the attempt number even when the frame is kept", () => {
    const after = fold([
      started("V1"),
      captured("V1"),
      started("V1", 2),
      failed("V1", 2),
    ]);
    expect(after.V1.attempts).toBe(2);
  });
});

describe("three of four is a result, and the counts say so", () => {
  it("counts only the directions the provider was asked for", () => {
    const after = fold([
      started("V1"),
      captured("V1"),
      started("V2"),
      captured("V2"),
      started("V3"),
      failed("V3"),
    ]);
    expect(readyCount(after)).toBe(2);
    // Three requested, not four: V4 is a wall shared with the building next
    // door and was never asked for, so counting it would report a failure where
    // nothing failed.
    expect(requestedCount(after)).toBe(3);
  });

  it("does not count a direction still queued for a retry as finished", () => {
    const after = fold([started("V1"), failed("V1", 1, true)]);
    expect(after.V1.phase).toBe("queued");
    expect(readyCount(after)).toBe(0);
  });
});

describe("every direction has a state at every moment", () => {
  it("has one before any event arrives", () => {
    for (const state of Object.values(seeded())) {
      expect(state.phase).toBeTruthy();
    }
  });

  it("still has one for all four after any sequence of events", () => {
    const sequences: CaptureEvent[][] = [
      [],
      [started("V1")],
      [started("V1"), failed("V1")],
      [started("V1"), captured("V1"), started("V2"), failed("V2", 1, true)],
      [started("V3"), captured("V3"), started("V3", 2), captured("V3", 2)],
    ];
    for (const events of sequences) {
      const after = concludeUnfinished(fold(events));
      expect(Object.keys(after).sort()).toEqual(["V1", "V2", "V3", "V4"]);
      for (const [slot, state] of Object.entries(after)) {
        expect(state?.phase, `${slot} after ${events.length} event(s)`).toMatch(
          /^(not-requested|queued|capturing|ready|failed)$/,
        );
      }
    }
  });
});
