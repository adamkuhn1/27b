import { useSyncExternalStore } from "react";
import { metrics, type MetricsSnapshot } from "../lib/metrics";

/** Subscribe a component to the shared metrics store. */
function useMetrics(): MetricsSnapshot {
  return useSyncExternalStore(
    (cb) => metrics.subscribe(cb),
    () => metrics.snapshot(),
    () => metrics.snapshot(),
  );
}

/**
 * The instrumentation panel (PLAN.md §6): addresses processed, pipeline latency,
 * cache hit rate. Every number is real (counted from pipeline events) but shown
 * as a draft estimate — the plan's instruction is to treat these as figures to
 * verify, not final claims.
 */
export function MetricsPanel() {
  const m = useMetrics();
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const ms = (n: number) => (n === 0 ? "—" : `${Math.round(n)} ms`);

  return (
    <section className="metrics" aria-label="Pipeline metrics">
      <div className="metrics__head">
        <h2 className="metrics__title">Pipeline metrics · session</h2>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => metrics.reset()}
        >
          Reset
        </button>
      </div>
      <div className="metrics__grid">
        <Metric value={String(m.addressesProcessed)} label="Addresses processed" />
        <Metric value={String(m.plansProduced)} label="Plans produced" />
        <Metric value={pct(m.cacheHitRate)} label="Cache hit rate" />
        <Metric value={ms(m.avgLatencyMs)} label="Avg latency" />
        <Metric value={ms(m.lastLatencyMs)} label="Last latency" />
        <Metric value={String(m.unavailable)} label="Unavailable" />
      </div>
      <p className="metrics__note">
        Draft session figures, not verified claims. Latency covers the geometry
        pipeline (geocode → footprint → camera math); cache hits skip the network
        entirely, which is what keeps the metered 3D-tile renders under the free
        cap.
      </p>
    </section>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="metric">
      <div className="metric__value">{value}</div>
      <div className="metric__label">{label}</div>
    </div>
  );
}
