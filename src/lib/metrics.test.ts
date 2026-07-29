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

  it("notifies subscribers on change and stops after unsubscribe", () => {
    const m = new Metrics();
    let calls = 0;
    const unsub = m.subscribe(() => (calls += 1));
    m.recordAddress();
    expect(calls).toBe(1);
    unsub();
    m.recordAddress();
    expect(calls).toBe(1);
  });
});
