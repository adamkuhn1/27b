import { describe, it, expect, beforeEach, vi } from "vitest";
import { planView } from "./planView";
import { GeocodeError } from "../lib/geocode";
import { FootprintError } from "../lib/footprint";
import { clearCache } from "../lib/cache";
import { metrics } from "../lib/metrics";
import type { BuildingFootprint, GeocodeResult } from "../lib/types";

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
  groundElevationM: 8,
  centroid: { lat: 40.7069, lng: -74.0113 },
};

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
    await planView("11 Wall St", 27, undefined, { geocode, fetchFootprint });
    const second = await planView("11 Wall St", 27, undefined, {
      geocode,
      fetchFootprint,
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.fromCache).toBe(true);
    // Network deps only called once despite two lookups.
    expect(geocode).toHaveBeenCalledTimes(1);
    expect(fetchFootprint).toHaveBeenCalledTimes(1);
    expect(metrics.snapshot().cacheHits).toBe(1);
  });
});

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
    });
    const snap = metrics.snapshot();
    expect(snap.addressesProcessed).toBe(1);
    expect(snap.plansProduced).toBe(1);
  });
});
