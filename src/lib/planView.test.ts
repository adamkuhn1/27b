// The pipeline's honesty properties, proven with injected deps (no network):
// every failure routes to a structured unavailable result, the curated gate
// refuses before any footprint work, and a produced plan carries real geometry
// derived from the injected footprint — never invented coordinates.

import { describe, expect, it, vi } from "vitest";
import { planView } from "./planView";
import { GeocodeError } from "./geocode";
import { FootprintError } from "./footprint";
import { CURATED_BUILDINGS } from "./curated";
import type { BuildingFootprint, GeocodeResult } from "./types";

const ESB = CURATED_BUILDINGS.find((b) => b.name === "Empire State Building")!;

const geocodeOk = (bin?: string) =>
  vi.fn(
    async (): Promise<GeocodeResult> => ({
      label: "350 5 AVENUE, New York, NY, USA",
      lat: 40.748441,
      lng: -73.985656,
      bin,
      borough: "Manhattan",
    }),
  );

const footprint: BuildingFootprint = {
  bin: ESB.bin,
  roofHeightM: 380,
  groundElevationNavd88M: 15,
  centroid: { lat: 40.748441, lng: -73.985656 },
  ring: [
    [-73.9861, 40.748],
    [-73.9851, 40.748],
    [-73.9851, 40.7489],
    [-73.9861, 40.7489],
    [-73.9861, 40.748],
  ],
};
const fetchFootprintOk = () => vi.fn(async () => footprint);

describe("planView", () => {
  it("produces a plan for a curated building at a verified floor", async () => {
    const result = await planView("350 5th Ave", 80, undefined, {
      geocode: geocodeOk(ESB.bin),
      fetchFootprint: fetchFootprintOk(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.curatedName).toBe(ESB.name);
    expect(result.plan.views).toHaveLength(4);
    // The ellipsoidal height must carry the ~-32 m NYC geoid correction.
    expect(
      result.plan.eyeElevationNavd88M - result.plan.eyeElevationEllipsoidalM,
    ).toBeGreaterThan(25);
  });

  it("refuses an un-curated building BEFORE fetching its footprint", async () => {
    const fetchFootprint = fetchFootprintOk();
    const result = await planView("999 Nowhere St", 5, undefined, {
      geocode: geocodeOk("1000001"), // real-shaped BIN, not on the list
      fetchFootprint,
    });
    expect(result).toMatchObject({ ok: false, reason: "not-supported" });
    expect(fetchFootprint).not.toHaveBeenCalled();
  });

  it("refuses a curated building outside its verified floor range, naming the range", async () => {
    const result = await planView("350 5th Ave", 2, undefined, {
      geocode: geocodeOk(ESB.bin),
      fetchFootprint: fetchFootprintOk(),
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "not-supported",
      supportedFloors: ESB.floors,
    });
  });

  it("maps a missing BIN to no-footprint", async () => {
    const result = await planView("1 Somewhere", 3, undefined, {
      geocode: geocodeOk(undefined),
      fetchFootprint: fetchFootprintOk(),
    });
    expect(result).toMatchObject({ ok: false, reason: "no-footprint" });
  });

  it("routes geocode errors to their own reasons", async () => {
    for (const kind of ["not-nyc", "geocode-failed", "network-error"] as const) {
      const result = await planView("x", 3, undefined, {
        geocode: vi.fn(async () => {
          throw new GeocodeError("nope", kind);
        }),
        fetchFootprint: fetchFootprintOk(),
      });
      expect(result).toMatchObject({ ok: false, reason: kind, message: "nope" });
    }
  });

  it("routes footprint errors to their own reasons", async () => {
    const result = await planView("350 5th Ave", 80, undefined, {
      geocode: geocodeOk(ESB.bin),
      fetchFootprint: vi.fn(async () => {
        throw new FootprintError("no record", "no-footprint");
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: "no-footprint" });
  });

  it("re-throws an abort instead of converting it into a result", async () => {
    await expect(
      planView("350 5th Ave", 80, undefined, {
        geocode: vi.fn(async () => {
          throw new DOMException("Aborted", "AbortError");
        }),
        fetchFootprint: fetchFootprintOk(),
      }),
    ).rejects.toThrow("Aborted");
  });
});

describe("curated list integrity", () => {
  it("has unique BINs and sane floor ranges", () => {
    const bins = CURATED_BUILDINGS.map((b) => b.bin);
    expect(new Set(bins).size).toBe(bins.length);
    for (const b of CURATED_BUILDINGS) {
      expect(b.floors.min).toBeGreaterThanOrEqual(1);
      expect(b.floors.max).toBeGreaterThanOrEqual(b.floors.min);
      expect(b.suggestedFloor).toBeGreaterThanOrEqual(b.floors.min);
      expect(b.suggestedFloor).toBeLessThanOrEqual(b.floors.max);
      expect(b.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(/^\d{7}$/.test(b.bin)).toBe(true);
    }
  });
});
