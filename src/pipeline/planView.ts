// The geometry pipeline: (address, floor) -> ViewPlan | honest unavailable.
//
// This orchestrates the real-data half end to end. Every failure path returns a
// structured `{ ok: false, reason }` that the UI renders as the same honest
// "not available for this address yet" state. There is deliberately NO code path
// here that fabricates coordinates, a building, or a scene: if real data is
// missing, the request is unavailable, full stop.

import { geocodeAddress, GeocodeError } from "../lib/geocode";
import { fetchFootprintByBin, FootprintError } from "../lib/footprint";
import { estimateFloorElevation, buildCameraViews } from "../lib/geometry";
import { readPlan, writePlan } from "../lib/cache";
import { metrics } from "../lib/metrics";
import type {
  ViewPlan,
  ViewPlanResult,
  UnavailableReason,
} from "../lib/types";

/** Dependencies are injectable so the pipeline is unit-testable without network. */
export interface PlanDeps {
  geocode: typeof geocodeAddress;
  fetchFootprint: typeof fetchFootprintByBin;
  now: () => number;
}

const defaultDeps: PlanDeps = {
  geocode: geocodeAddress,
  fetchFootprint: fetchFootprintByBin,
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
};

function unavailable(
  reason: UnavailableReason,
  message: string,
): ViewPlanResult {
  metrics.recordUnavailable();
  return { ok: false, reason, message };
}

/**
 * Produce a ViewPlan for an address + floor, or an honest unavailable result.
 * `address` and `floor` are assumed already validated by lib/validation.
 */
export async function planView(
  address: string,
  floor: number,
  signal?: AbortSignal,
  deps: Partial<PlanDeps> = {},
): Promise<ViewPlanResult> {
  const d: PlanDeps = { ...defaultDeps, ...deps };
  metrics.recordAddress();

  // 1. Cache: geometry is deterministic per (address, floor), so a hit is a
  //    complete, real plan — no network, no tile events.
  const cached = readPlan(address, floor);
  if (cached) {
    metrics.recordCacheHit();
    return { ok: true, plan: cached, fromCache: true };
  }
  metrics.recordCacheMiss();

  const started = d.now();

  try {
    // 2. Geocode (NYC-only service doubles as the NYC gate).
    const geo = await d.geocode(address, signal);

    if (!geo.bin) {
      // No BIN means we can't join to a building footprint. Honest fail.
      return unavailable(
        "no-footprint",
        "We found the address but not a specific building record for it yet.",
      );
    }

    // 3. Footprint height + centroid.
    const footprint = await d.fetchFootprint(geo.bin, signal);

    // 4. Geometry math (pure, real): elevation + four cardinal cameras.
    const { eyeElevationM, clampedToRoof } = estimateFloorElevation(
      footprint,
      floor,
    );
    const views = buildCameraViews(footprint, eyeElevationM);

    const plan: ViewPlan = {
      address,
      floor,
      geocode: geo,
      footprint,
      eyeElevationM,
      floorClampedToRoof: clampedToRoof,
      views,
    };

    metrics.recordLatency(d.now() - started);
    metrics.recordPlanProduced();
    writePlan(address, floor, plan);
    return { ok: true, plan, fromCache: false };
  } catch (err) {
    metrics.recordLatency(d.now() - started);

    if (err instanceof DOMException && err.name === "AbortError") {
      // Caller cancelled (e.g. new search). Re-throw so the UI can ignore it.
      throw err;
    }
    if (err instanceof GeocodeError) {
      return unavailable(err.kind, err.message);
    }
    if (err instanceof FootprintError) {
      return unavailable(err.kind, err.message);
    }
    // Unknown error: still honest, never a fake scene.
    return unavailable(
      "network-error",
      "Something went wrong resolving this address. Please try again.",
    );
  }
}
