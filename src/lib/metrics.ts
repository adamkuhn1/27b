// Lightweight, in-memory instrumentation (PLAN.md §6).
//
// Tracks the three numbers the plan asks 27B to instrument from the start:
//   - addresses processed
//   - imagery-pipeline latency
//   - cache hit rate
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
}

interface MetricsState {
  addressesProcessed: number;
  cacheHits: number;
  cacheMisses: number;
  plansProduced: number;
  unavailable: number;
  latencySamples: number[];
}

function emptyState(): MetricsState {
  return {
    addressesProcessed: 0,
    cacheHits: 0,
    cacheMisses: 0,
    plansProduced: 0,
    unavailable: 0,
    latencySamples: [],
  };
}

/**
 * A tiny observable metrics store. One instance is shared app-wide (see the
 * default export), but the class is exported so tests get a clean instance.
 */
export class Metrics {
  private state = emptyState();
  private listeners = new Set<() => void>();

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

  snapshot(): MetricsSnapshot {
    const { cacheHits, cacheMisses, latencySamples } = this.state;
    const lookups = cacheHits + cacheMisses;
    const avg =
      latencySamples.length === 0
        ? 0
        : latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length;
    return {
      addressesProcessed: this.state.addressesProcessed,
      cacheHits,
      cacheMisses,
      cacheHitRate: lookups === 0 ? 0 : cacheHits / lookups,
      plansProduced: this.state.plansProduced,
      unavailable: this.state.unavailable,
      avgLatencyMs: avg,
      lastLatencyMs: latencySamples.at(-1) ?? 0,
    };
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
    this.listeners.forEach((l) => l());
  }
}

/** App-wide shared metrics instance. */
export const metrics = new Metrics();
