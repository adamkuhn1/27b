import { describe, it, expect, beforeEach, vi } from "vitest";
import { planView } from "./planView";
import { GeocodeError } from "../lib/geocode";
import { FootprintError } from "../lib/footprint";
import { NeighborError } from "../lib/neighbors";
import { isDirectionRequested } from "../lib/directionClass";
import { clearCache } from "../lib/cache";
import { metrics } from "../lib/metrics";
import type {
  BuildingFootprint,
  GeocodeResult,
  NeighborBuilding,
} from "../lib/types";

// A minimal in-memory localStorage so the cache layer works in Node.
function installLocalStorage() {
  const map = new Map<string, string>();
  const store: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  };
  (globalThis as unknown as { localStorage: Storage }).localStorage = store;
}

const geo: GeocodeResult = {
  label: "11 Wall St, Manhattan",
  lat: 40.7069,
  lng: -74.0113,
  bin: "1001001",
  borough: "Manhattan",
};

const footprint: BuildingFootprint = {
  bin: "1001001",
  roofHeightM: 100,
  groundElevationNavd88M: 8,
  centroid: { lat: 40.7069, lng: -74.0113 },
  // Minimal rectangular ring (~40 m × 40 m) so facade-distance geometry works.
  ring: [
    [-74.0117, 40.7065],
    [-74.0109, 40.7065],
    [-74.0109, 40.7073],
    [-74.0117, 40.7073],
    [-74.0117, 40.7065],
  ],
};

/** A tower 30 m due north-north-east of the subject, tall enough to block. */
const blockingNeighbor: NeighborBuilding = {
  bin: "1002002",
  roofHeightM: 200,
  groundElevationNavd88M: 8,
  ring: [
    [-74.01135, 40.70755],
    [-74.01105, 40.70755],
    [-74.01105, 40.70785],
    [-74.01135, 40.70785],
    [-74.01135, 40.70755],
  ],
};

/**
 * Every test in this file is offline. `fetchNeighbors` is stubbed by default so
 * the pipeline never reaches a network, and a test that wants a failure asks
 * for one explicitly.
 */
const stubNeighbors = (
  neighbors: NeighborBuilding[] = [],
  incomplete = false,
) => vi.fn().mockResolvedValue({ neighbors, incomplete });

beforeEach(() => {
  installLocalStorage();
  clearCache();
  metrics.reset();
});

describe("planView — happy path", () => {
  it("produces a real four-view plan from geocode + footprint", async () => {
    const res = await planView("11 Wall St", 27, undefined, {
      geocode: vi.fn().mockResolvedValue(geo),
      fetchFootprint: vi.fn().mockResolvedValue(footprint),
      fetchNeighbors: stubNeighbors(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.views).toHaveLength(4);
    expect(res.plan.floor).toBe(27);
    expect(res.plan.geocode.bin).toBe("1001001");
    expect(res.fromCache).toBe(false);
  });

  it("serves the second identical request from cache (zero network)", async () => {
    const geocode = vi.fn().mockResolvedValue(geo);
    const fetchFootprint = vi.fn().mockResolvedValue(footprint);
    const neighbors = stubNeighbors();
    const deps = { geocode, fetchFootprint, fetchNeighbors: neighbors };
    await planView("11 Wall St", 27, undefined, deps);
    const second = await planView("11 Wall St", 27, undefined, deps);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.fromCache).toBe(true);
    // Network deps only called once despite two lookups.
    expect(geocode).toHaveBeenCalledTimes(1);
    expect(fetchFootprint).toHaveBeenCalledTimes(1);
    expect(neighbors).toHaveBeenCalledTimes(1);
    expect(metrics.snapshot().cacheHits).toBe(1);
  });
});

describe("planView — the enclosure layer is an annotation, never the result", () => {
  const deps = (fetchNeighbors: PlanDepsNeighbors) => ({
    geocode: vi.fn().mockResolvedValue(geo),
    fetchFootprint: vi.fn().mockResolvedValue(footprint),
    fetchNeighbors,
  });

  it("attaches a per-direction assessment when neighbours resolve", async () => {
    const res = await planView(
      "11 Wall St",
      3,
      undefined,
      deps(stubNeighbors([blockingNeighbor])),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.confidence).not.toBeNull();
    expect(res.plan.confidence!.neighborsConsidered).toBe(1);
    for (const view of res.plan.views) {
      expect(res.plan.confidence!.bySlot[view.slot]).toBeDefined();
    }
    // The tower is due NNE and towers over floor 3, so that direction is not open.
    const bands = res.plan.views.map(
      (v) => res.plan.confidence!.bySlot[v.slot]!.band,
    );
    expect(bands).toContain("enclosed");
  });

  it("still produces the full plan when the neighbour lookup fails", async () => {
    const res = await planView(
      "11 Wall St",
      27,
      undefined,
      deps(vi.fn().mockRejectedValue(new NeighborError("service down"))),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.views).toHaveLength(4);
    // null means "no notes available" — it must never be read as "open".
    expect(res.plan.confidence).toBeNull();
  });

  it("still produces the full plan when the neighbour lookup hangs past its budget", async () => {
    vi.useFakeTimers();
    try {
      const hang = vi.fn(
        (_lat: number, _lng: number, _r: number, signal?: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () =>
              reject(new NeighborError("aborted")),
            );
          }),
      );
      const pending = planView("11 Wall St", 27, undefined, deps(hang as never));
      await vi.advanceTimersByTimeAsync(5000);
      const res = await pending;
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.plan.confidence).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries the incomplete-neighbour-data flag through to the plan", async () => {
    const res = await planView(
      "11 Wall St",
      27,
      undefined,
      deps(stubNeighbors([blockingNeighbor], true)),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.plan.confidence!.neighborDataIncomplete).toBe(true);
  });

  it("records the footprint's rectangularity instead of discarding it", async () => {
    const res = await planView("11 Wall St", 27, undefined, deps(stubNeighbors()));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.plan.facadeConcentration).toBeGreaterThan(0.9);
  });
});

type PlanDepsNeighbors = Parameters<typeof planView>[3] extends
  | { fetchNeighbors?: infer F }
  | undefined
  ? F
  : never;

describe("planView — honest failure routing (never a fake scene)", () => {
  it("routes a geocode 'not-nyc' error to unavailable", async () => {
    const res = await planView("1 Infinite Loop", 3, undefined, {
      geocode: vi
        .fn()
        .mockRejectedValue(new GeocodeError("outside NYC", "not-nyc")),
      fetchFootprint: vi.fn(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not-nyc");
  });

  it("routes a missing BIN to no-footprint without calling footprint service", async () => {
    const fetchFootprint = vi.fn();
    const res = await planView("123 Somewhere St", 3, undefined, {
      geocode: vi.fn().mockResolvedValue({ ...geo, bin: undefined }),
      fetchFootprint,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("no-footprint");
    expect(fetchFootprint).not.toHaveBeenCalled();
  });

  it("routes a footprint 'no-footprint' error to unavailable", async () => {
    const res = await planView("456 Nowhere Ave", 3, undefined, {
      geocode: vi.fn().mockResolvedValue(geo),
      fetchFootprint: vi
        .fn()
        .mockRejectedValue(new FootprintError("no record", "no-footprint")),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("no-footprint");
  });

  it("routes an unknown error to network-error, still no fake scene", async () => {
    const res = await planView("789 Broken Rd", 3, undefined, {
      geocode: vi.fn().mockRejectedValue(new Error("boom")),
      fetchFootprint: vi.fn(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("network-error");
  });

  it("re-throws AbortError so a superseded request is ignored", async () => {
    const abort = new DOMException("aborted", "AbortError");
    await expect(
      planView("11 Wall St", 3, undefined, {
        geocode: vi.fn().mockRejectedValue(abort),
        fetchFootprint: vi.fn(),
      }),
    ).rejects.toThrow(/aborted/);
  });
});

describe("planView — metrics", () => {
  it("counts addresses processed and plans produced", async () => {
    await planView("11 Wall St", 27, undefined, {
      geocode: vi.fn().mockResolvedValue(geo),
      fetchFootprint: vi.fn().mockResolvedValue(footprint),
      fetchNeighbors: stubNeighbors(),
    });
    const snap = metrics.snapshot();
    expect(snap.addressesProcessed).toBe(1);
    expect(snap.plansProduced).toBe(1);
  });
});

describe("planView — a camera that would stand inside the building opposite", () => {
  /**
   * A tall slab whose west wall is ~4 m east of the subject's east wall: a
   * light court narrower than the 6 m the camera is normally pushed out.
   */
  const acrossACourt: NeighborBuilding = {
    bin: "1003003",
    roofHeightM: 200,
    groundElevationNavd88M: 8,
    ring: [
      [-74.01085, 40.7065],
      [-74.0106, 40.7065],
      [-74.0106, 40.7073],
      [-74.01085, 40.7073],
      [-74.01085, 40.7065],
    ],
  };

  const run = (neighbors: NeighborBuilding[], address: string) =>
    planView(address, 27, undefined, {
      geocode: vi.fn().mockResolvedValue(geo),
      fetchFootprint: vi.fn().mockResolvedValue(footprint),
      fetchNeighbors: stubNeighbors(neighbors),
    });

  it("moves that one camera into the court and leaves the others alone", async () => {
    const open = await run([], "11 Wall St open");
    const court = await run([acrossACourt], "11 Wall St court");
    expect(open.ok && court.ok).toBe(true);
    if (!open.ok || !court.ok) return;

    const bySlot = (r: typeof open) =>
      Object.fromEntries(r.plan.views.map((v) => [v.slot, v]));
    const before = bySlot(open);
    const after = bySlot(court);

    // V2 is the east-facing view, the one across the court.
    expect(after.V2.standoffM).toBeLessThan(before.V2.standoffM);
    expect(after.V2.standoffM - after.V2.wallDistanceM).toBeCloseTo(2, 0);

    // The other three keep the full offset: a court is a per-direction fact.
    for (const slot of ["V1", "V3", "V4"]) {
      expect(after[slot].standoffM).toBeCloseTo(before[slot].standoffM, 6);
    }
  });

  it("still reports the court after re-measuring from inside it", async () => {
    // The moved camera no longer stands inside the neighbour, so a second pass
    // that simply overwrote the first would lose the reason it was moved and
    // present a 2 m standoff as an ordinary view.
    const res = await run([acrossACourt], "11 Wall St carried");
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const v2 = res.plan.confidence!.bySlot.V2!;
    expect(v2.courtWidthM).toBeCloseTo(4, 0);
    expect(v2.insideNeighborByM).toBeNull();
  });

  it("keeps the direction renderable — the window is real", async () => {
    // The whole point of the change. Before it, this facade was deleted from
    // the result as though it were a party wall.
    const res = await run([acrossACourt], "11 Wall St renderable");
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(isDirectionRequested("V2", res.plan.confidence)).toBe(true);
    const requested = res.plan.views.filter((v) =>
      isDirectionRequested(v.slot, res.plan.confidence),
    );
    expect(requested).toHaveLength(4);
  });

  it("does not run a second placement pass when no direction needs one", async () => {
    // The common case. Cameras must be bit-identical to a single-pass build,
    // so the two-pass machinery cannot perturb ordinary results.
    const withTower = await run([blockingNeighbor], "11 Wall St tower");
    const withNothing = await run([], "11 Wall St nothing");
    expect(withTower.ok && withNothing.ok).toBe(true);
    if (!withTower.ok || !withNothing.ok) return;

    for (let i = 0; i < 4; i++) {
      expect(withTower.plan.views[i].standoffM).toBe(
        withNothing.plan.views[i].standoffM,
      );
      expect(withTower.plan.views[i].lat).toBe(withNothing.plan.views[i].lat);
      expect(withTower.plan.views[i].lng).toBe(withNothing.plan.views[i].lng);
    }
  });
});
