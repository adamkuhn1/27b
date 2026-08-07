import { describe, it, expect } from "vitest";
import { Metrics } from "./metrics";

describe("Metrics", () => {
  it("computes cache hit rate from hits and misses", () => {
    const m = new Metrics();
    m.recordCacheHit();
    m.recordCacheHit();
    m.recordCacheMiss();
    expect(m.snapshot().cacheHitRate).toBeCloseTo(2 / 3, 6);
  });

  it("reports 0 hit rate before any lookup", () => {
    expect(new Metrics().snapshot().cacheHitRate).toBe(0);
  });

  it("averages latency samples", () => {
    const m = new Metrics();
    m.recordLatency(100);
    m.recordLatency(200);
    const snap = m.snapshot();
    expect(snap.avgLatencyMs).toBe(150);
    expect(snap.lastLatencyMs).toBe(200);
  });

  it("ignores negative latency samples", () => {
    const m = new Metrics();
    m.recordLatency(-5);
    expect(m.snapshot().avgLatencyMs).toBe(0);
  });

  it("counts SESSIONS, not frames, for the cost-shaped meter", () => {
    // The billable unit for Photorealistic 3D Tiles is the root tileset
    // request — one per session, however many frames or in-session retries
    // follow. A frame counter would produce a number that doesn't match a bill.
    const m = new Metrics();
    m.recordSessionOpened();
    m.recordCaptureLatency(12000);
    m.recordCaptureLatency(14000);
    m.recordCaptureLatency(9000);
    m.recordCaptureLatency(11000);
    m.recordCaptureLatency(10000); // an in-session retry: free
    const snap = m.snapshot();
    expect(snap.sessionsOpened).toBe(1);
    expect(snap.capturesCompleted).toBe(5);
    expect(snap.avgCaptureLatencyMs).toBe(11200);
  });

  it("records time to first frame once per session, not once per frame", () => {
    const m = new Metrics();
    m.recordSessionOpened();
    m.recordCaptureLatency(12000);
    const first = m.snapshot().lastTimeToFirstFrameMs;
    m.recordCaptureLatency(14000);
    expect(m.snapshot().lastTimeToFirstFrameMs).toBe(first);
  });

  it("reports zero time-to-first-frame before any session", () => {
    expect(new Metrics().snapshot().lastTimeToFirstFrameMs).toBe(0);
  });

});
