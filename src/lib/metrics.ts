// Lightweight, in-memory instrumentation (PLAN.md §6).
//
// Tracks the numbers the plan asks 27B to instrument from the start:
//   - addresses processed
//   - GEOMETRY-pipeline latency (geocode -> footprint -> camera math)
//   - cache hit rate (geometry cache; imagery is never cached — see cache.ts)
//   - IMAGERY-pipeline latency: per-direction capture time, and time to first
//     frame
//   - render sessions opened (the cost meter)
//
// Naming precision matters here. Two different pipelines are measured and they
// differ by two orders of magnitude: the geometry pipeline is ~1 s, while the
// 3D-tile render is 35-65 s and dominates end-to-end time (measured 2026-08-04:
// 53.9 s / 37.1 s / 50.0 s / 62.1 s across four real runs). Reporting one
// number for "latency" would be misleading either way, so they are separate
// fields with separate names.
//
// `sessionsOpened` is the only cost-shaped counter. The billable unit for
// Photorealistic 3D Tiles is the root tileset request — one per session, not
// one per frame and not one per in-session retry — so counting frames would
// produce a number that does not correspond to the bill.
//
// TREAT EVERY NUMBER HERE AS A DRAFT ESTIMATE. The imagery counters have not
// yet been exercised against a real render: doing so costs a root tileset
// request, which is not authorized this sprint. They are exercised against
// stubs in metrics.test.ts, which proves the arithmetic and nothing about the
// wall-clock values.
//
// Deliberately dependency-free and honest: it counts real events the pipeline
// emits, computes derived rates on read, and treats every number as a draft
// estimate (the plan's instruction), surfaced in a small dev panel. A subscribe
// hook lets the UI re-render when metrics change without a state library.

export interface MetricsSnapshot {
  addressesProcessed: number;
  cacheHits: number;
  cacheMisses: number;
  /** cacheHits / (cacheHits + cacheMisses); 0 when no lookups yet. */
  cacheHitRate: number;
  /** Count of successfully-produced view plans. */
  plansProduced: number;
  /** Count of requests that ended in the honest "unavailable" state. */
  unavailable: number;
  /** Mean pipeline latency (ms) across measured runs; 0 when none. */
  avgLatencyMs: number;
  /** Most recent pipeline latency (ms); 0 when none. */
  lastLatencyMs: number;
  /**
   * Render sessions opened. This is the COST meter: the billable unit for
   * Photorealistic 3D Tiles is the root tileset request, i.e. one per session,
   * however many frames or in-session retries follow. Counting frames would
   * produce a number that does not correspond to the bill.
   */
  sessionsOpened: number;
  /** Frames captured. Not a cost figure — see `sessionsOpened`. */
  capturesCompleted: number;
  /** Mean per-direction capture latency (ms); 0 when none. */
  avgCaptureLatencyMs: number;
  /**
   * Time from opening a session to its first frame (ms), most recent session.
   * The number the progressive-render work exists to move: it used to be
   * indistinguishable from the whole-session time because nothing was shown
   * until all four finished.
   */
  lastTimeToFirstFrameMs: number;
}

interface MetricsState {
  addressesProcessed: number;
  cacheHits: number;
  cacheMisses: number;
  plansProduced: number;
  unavailable: number;
  latencySamples: number[];
  sessionsOpened: number;
  captureLatencySamples: number[];
  /** performance.now() at the most recent session open, or null. */
  sessionOpenedAt: number | null;
  lastTimeToFirstFrameMs: number;
}

function emptyState(): MetricsState {
  return {
    addressesProcessed: 0,
    cacheHits: 0,
    cacheMisses: 0,
    plansProduced: 0,
    unavailable: 0,
    latencySamples: [],
    sessionsOpened: 0,
    captureLatencySamples: [],
    sessionOpenedAt: null,
    lastTimeToFirstFrameMs: 0,
  };
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * A tiny observable metrics store. One instance is shared app-wide (see the
 * default export), but the class is exported so tests get a clean instance.
 */
export class Metrics {
  private state = emptyState();
  private listeners = new Set<() => void>();
  // Cached snapshot: same reference is returned until emit() invalidates it.
  // Required by useSyncExternalStore — getSnapshot must be referentially stable
  // between mutations or React triggers an infinite update loop.
  private _cache: MetricsSnapshot | null = null;

  /** Record that a new address request started. */
  recordAddress(): void {
    this.state.addressesProcessed += 1;
    this.emit();
  }

  recordCacheHit(): void {
    this.state.cacheHits += 1;
    this.emit();
  }

  recordCacheMiss(): void {
    this.state.cacheMisses += 1;
    this.emit();
  }

  recordPlanProduced(): void {
    this.state.plansProduced += 1;
    this.emit();
  }

  recordUnavailable(): void {
    this.state.unavailable += 1;
    this.emit();
  }

  /** Record one end-to-end pipeline latency sample (ms). */
  recordLatency(ms: number): void {
    if (Number.isFinite(ms) && ms >= 0) {
      this.state.latencySamples.push(ms);
      this.emit();
    }
  }

  /**
   * Record that a render session opened. One session = one root tileset
   * request = one billable unit, regardless of how many frames follow.
   */
  recordSessionOpened(): void {
    this.state.sessionsOpened += 1;
    this.state.sessionOpenedAt = nowMs();
    this.emit();
  }

  /** Record one per-direction capture latency (ms), as reported by the session. */
  recordCaptureLatency(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.state.captureLatencySamples.push(ms);
    if (this.state.sessionOpenedAt !== null) {
      // First frame of this session: the gap the progressive work targets.
      this.state.lastTimeToFirstFrameMs = nowMs() - this.state.sessionOpenedAt;
      this.state.sessionOpenedAt = null;
    }
    this.emit();
  }

  snapshot(): MetricsSnapshot {
    if (this._cache) return this._cache;
    const { cacheHits, cacheMisses, latencySamples, captureLatencySamples } =
      this.state;
    const lookups = cacheHits + cacheMisses;
    const mean = (xs: number[]) =>
      xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
    this._cache = {
      addressesProcessed: this.state.addressesProcessed,
      cacheHits,
      cacheMisses,
      cacheHitRate: lookups === 0 ? 0 : cacheHits / lookups,
      plansProduced: this.state.plansProduced,
      unavailable: this.state.unavailable,
      avgLatencyMs: mean(latencySamples),
      lastLatencyMs: latencySamples.at(-1) ?? 0,
      sessionsOpened: this.state.sessionsOpened,
      capturesCompleted: captureLatencySamples.length,
      avgCaptureLatencyMs: mean(captureLatencySamples),
      lastTimeToFirstFrameMs: this.state.lastTimeToFirstFrameMs,
    };
    return this._cache;
  }

  /** Subscribe to changes; returns an unsubscribe fn (React-friendly). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(): void {
    this.state = emptyState();
    this.emit();
  }

  private emit(): void {
    this._cache = null; // invalidate so next snapshot() recomputes
    this.listeners.forEach((l) => l());
  }
}

/** App-wide shared metrics instance. */
export const metrics = new Metrics();
