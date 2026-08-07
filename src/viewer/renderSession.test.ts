// Progressive render behaviour, driven by a fake FrameSource.
//
// No Cesium, no WebGL, no API key, no provider request. That is the point of
// splitting the policy out of tileRenderer.ts: the interesting behaviour —
// partial success, per-direction retry, abort, the billable-unit invariant —
// is exactly the behaviour that would otherwise cost money to exercise.

import { describe, it, expect, vi } from "vitest";
import {
  CaptureFailedError,
  createRenderSession,
  type FrameSource,
} from "./renderSession";
import type { CameraView, CaptureEvent, CaptureResult, ViewSlot } from "../lib/types";
import { VIEW_SLOTS } from "../lib/types";

function view(slot: ViewSlot, headingDeg: number): CameraView {
  return {
    slot,
    headingDeg,
    compass: "N",
    lat: 40.7484,
    lng: -73.9857,
    heightM: 100,
    pitchDeg: -5,
    standoffM: 36,
    wallDistanceM: 30,
  };
}

const VIEWS = VIEW_SLOTS.map((slot, i) => view(slot, 29 + 90 * i));

function frame(slot: ViewSlot): CaptureResult {
  return {
    slot,
    // A 1x1 transparent PNG. Real bytes, produced here, standing in for a real
    // capture — the fake is the *source*, never a scene shown to anyone.
    dataUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    attribution: ["Google", `Vexcel ${slot}`],
  };
}

/** A FrameSource whose behaviour per slot is scripted by the test. */
function fakeSource(
  script: Partial<Record<ViewSlot, Array<"ok" | "fail" | "taint">>> = {},
  opts: { settled?: boolean } = {},
): FrameSource & { calls: ViewSlot[]; closed: number } {
  const calls: ViewSlot[] = [];
  let closed = 0;
  const remaining = new Map<ViewSlot, Array<"ok" | "fail" | "taint">>(
    Object.entries(script) as Array<[ViewSlot, Array<"ok" | "fail" | "taint">]>,
  );
  return {
    calls,
    get closed() {
      return closed;
    },
    async capture(v: CameraView) {
      calls.push(v.slot);
      const next = remaining.get(v.slot)?.shift() ?? "ok";
      if (next === "fail") {
        throw new CaptureFailedError({
          kind: "capture-failed",
          detail: `synthetic failure for ${v.slot}`,
          fatalForSession: false,
        });
      }
      if (next === "taint") {
        throw new CaptureFailedError({
          kind: "readback-blocked",
          detail: "Canvas readback blocked (CORS taint)",
          fatalForSession: true,
        });
      }
      return { result: frame(v.slot), settled: opts.settled ?? true };
    },
    close() {
      closed += 1;
    },
  };
}

async function drain(events: AsyncIterable<CaptureEvent>): Promise<CaptureEvent[]> {
  const out: CaptureEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

type Captured = Extract<CaptureEvent, { kind: "view-captured" }>;
type Failed = Extract<CaptureEvent, { kind: "view-failed" }>;

const captured = (events: CaptureEvent[]): Captured[] =>
  events.filter((e): e is Captured => e.kind === "view-captured");
const failedFinal = (events: CaptureEvent[]): Failed[] =>
  events.filter((e): e is Failed => e.kind === "view-failed" && !e.willRetry);

describe("render session — every frame is handed over as it lands", () => {
  it("emits four captures in view order, each as a separate event", async () => {
    const source = fakeSource();
    const events = await drain(createRenderSession(VIEWS, source).events);

    expect(events[0]).toEqual({ kind: "session-open", rootRequests: 1 });
    expect(captured(events).map((e) => e.result.slot)).toEqual([
      "V1",
      "V2",
      "V3",
      "V4",
    ]);
    expect(events.at(-1)).toEqual({ kind: "session-closed", reason: "complete" });
  });

  it("interleaves view-started with each capture, so a UI can show which direction is live", async () => {
    const events = await drain(createRenderSession(VIEWS, fakeSource()).events);
    const kinds = events
      .filter((e) => e.kind === "view-started" || e.kind === "view-captured")
      .map((e) => e.kind);
    expect(kinds).toEqual([
      "view-started",
      "view-captured",
      "view-started",
      "view-captured",
      "view-started",
      "view-captured",
      "view-started",
      "view-captured",
    ]);
  });

  it("reports settled:false when the hard timeout fired instead of the settle grace", async () => {
    const events = await drain(
      createRenderSession(VIEWS, fakeSource({}, { settled: false })).events,
    );
    expect(captured(events).every((e) => !e.settled)).toBe(true);
  });

  it("reports settled:true when tile activity went quiet", async () => {
    const events = await drain(createRenderSession(VIEWS, fakeSource()).events);
    expect(captured(events).every((e) => e.settled)).toBe(true);
  });
});

describe("render session — partial success survives", () => {
  it("keeps the frames that succeeded when one direction fails permanently", async () => {
    // V3 fails every attempt. Before the streaming refactor this threw out of
    // the whole four-view function and destroyed V1 and V2 as well.
    const source = fakeSource({ V3: ["fail", "fail", "fail"] });
    const events = await drain(createRenderSession(VIEWS, source).events);

    expect(captured(events).map((e) => e.result.slot).sort()).toEqual([
      "V1",
      "V2",
      "V4",
    ]);
    expect(failedFinal(events).map((e) => e.slot)).toEqual(["V3"]);
    expect(events.at(-1)).toMatchObject({ kind: "session-closed", reason: "complete" });
  });

  it("retries a failed direction once, automatically and in-session", async () => {
    const source = fakeSource({ V2: ["fail"] });
    const events = await drain(createRenderSession(VIEWS, source).events);

    // Re-queued at the back, so the other directions are not delayed by it.
    expect(source.calls).toEqual(["V1", "V2", "V3", "V4", "V2"]);
    expect(captured(events).map((e) => e.result.slot)).toEqual([
      "V1",
      "V3",
      "V4",
      "V2",
    ]);
    expect(failedFinal(events)).toHaveLength(0);
  });

  it("stops automatic retries at the cap and marks the direction failed", async () => {
    const source = fakeSource({ V1: ["fail", "fail", "fail", "fail"] });
    const events = await drain(
      createRenderSession(VIEWS, source, { maxAutoAttemptsPerSlot: 2 }).events,
    );
    expect(source.calls.filter((s) => s === "V1")).toHaveLength(2);
    expect(failedFinal(events).map((e) => e.slot)).toEqual(["V1"]);
  });

  it("delivers nothing but honest failure when every direction fails", async () => {
    const source = fakeSource({
      V1: Array(4).fill("fail"),
      V2: Array(4).fill("fail"),
      V3: Array(4).fill("fail"),
      V4: Array(4).fill("fail"),
    });
    const events = await drain(createRenderSession(VIEWS, source).events);
    expect(captured(events)).toHaveLength(0);
    expect(failedFinal(events)).toHaveLength(4);
    // No event carries a dataUrl, so nothing could be drawn even by mistake.
    expect(events.some((e) => "result" in e)).toBe(false);
  });
});

describe("render session — a tainted canvas is a session failure, not a view failure", () => {
  it("stops immediately rather than burning a timeout per remaining direction", async () => {
    const source = fakeSource({ V2: ["taint"] });
    const events = await drain(createRenderSession(VIEWS, source).events);

    expect(source.calls).toEqual(["V1", "V2"]);
    expect(captured(events).map((e) => e.result.slot)).toEqual(["V1"]);
    const failure = events.find((e) => e.kind === "view-failed");
    expect(failure).toMatchObject({ slot: "V2", willRetry: false });
    expect(events.at(-1)).toEqual({ kind: "session-closed", reason: "fatal" });
    expect(source.closed).toBe(1);
  });
});

describe("render session — abort", () => {
  it("writes no further events and closes the source", async () => {
    const controller = new AbortController();
    const releases: Array<() => void> = [];
    const source: FrameSource = {
      capture: vi.fn(async (v: CameraView) => {
        await new Promise<void>((r) => releases.push(r));
        return { result: frame(v.slot), settled: true };
      }),
      close: vi.fn(),
    };

    const session = createRenderSession(VIEWS, source, { signal: controller.signal });
    const collected: CaptureEvent[] = [];
    const pump = (async () => {
      for await (const e of session.events) collected.push(e);
    })();

    await Promise.resolve();
    controller.abort();
    releases.forEach((r) => r());
    await pump;

    expect(collected.at(-1)).toEqual({ kind: "session-closed", reason: "aborted" });
    expect(collected.filter((e) => e.kind === "view-captured")).toHaveLength(0);
    expect(source.close).toHaveBeenCalled();
    expect(session.isOpen).toBe(false);
  });
});

describe("render session — the billable-unit invariant", () => {
  it("emits exactly one session-open, and a recapture emits none", async () => {
    // The provider bills the root tileset request, not the frame: "Timed
    // session tokens allow for up to three hours of renderer tile requests from
    // a single root tileset request". A retry inside an open session must
    // therefore be free. Asserted here rather than trusted, because getting it
    // wrong is a billing bug that no type checks.
    const source = fakeSource({ V1: ["fail"] });
    const session = createRenderSession(VIEWS, source);
    const collected: CaptureEvent[] = [];
    const pump = (async () => {
      for await (const e of session.events) collected.push(e);
    })();

    session.recapture("V3");
    await pump;

    expect(collected.filter((e) => e.kind === "session-open")).toHaveLength(1);
    expect(source.calls.filter((s) => s === "V3")).toHaveLength(2);
  });

  it("resolves recapture() with the resulting event", async () => {
    const session = createRenderSession(VIEWS, fakeSource());
    const pump = drain(session.events);
    const result = await session.recapture("V2");
    await pump;
    expect(result).toMatchObject({ kind: "view-captured" });
  });

  it("refuses a recapture past the per-slot cap", async () => {
    // maxAuto 1 removes the automatic retry so the manual budget is the only
    // thing under test; the three calls are made synchronously, before the
    // worker picks any of them up, which is exactly the case where a naive
    // counter lets two requests both claim the same attempt number.
    const source = fakeSource({ V1: Array(6).fill("fail") });
    const session = createRenderSession(VIEWS, source, {
      maxAutoAttemptsPerSlot: 1,
      maxAttemptsPerSlot: 3,
    });
    const pump = drain(session.events);
    const second = session.recapture("V1"); // attempt 2 — allowed
    const third = session.recapture("V1"); // attempt 3 — allowed
    const fourth = session.recapture("V1"); // attempt 4 — refused
    const results = await Promise.all([second, third, fourth]);
    await pump;

    expect(results[0]).toMatchObject({ kind: "view-failed", attempt: 2 });
    expect(results[1]).toMatchObject({ kind: "view-failed", attempt: 3 });
    expect(results[2]).toMatchObject({
      kind: "view-failed",
      failure: { detail: expect.stringContaining("Retry limit") },
    });
    expect(source.calls.filter((s) => s === "V1")).toHaveLength(3);
  });

  it("refuses a recapture once the session has closed, rather than silently costing a full render", async () => {
    const session = createRenderSession(VIEWS, fakeSource());
    await drain(session.events);
    expect(session.isOpen).toBe(false);

    const result = await session.recapture("V1");
    expect(result).toMatchObject({
      kind: "view-failed",
      failure: { detail: expect.stringContaining("Session is closed") },
    });
  });

  it("closes the frame source exactly once", async () => {
    const source = fakeSource();
    const session = createRenderSession(VIEWS, source);
    await drain(session.events);
    session.close();
    session.close();
    expect(source.closed).toBe(1);
  });
});
