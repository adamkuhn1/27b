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
import { fetchNeighbors, type NeighborSet } from "../lib/neighbors";
import {
  assessConfidence,
  courtOffsets,
  mergeCourtFindings,
  SEARCH_RADIUS_M,
} from "../lib/confidence";
import { readPlan, writePlan } from "../lib/cache";
import { metrics } from "../lib/metrics";
import type {
  BuildingFootprint,
  ViewPlan,
  ViewPlanResult,
  UnavailableReason,
} from "../lib/types";

/** Dependencies are injectable so the pipeline is unit-testable without network. */
export interface PlanDeps {
  geocode: typeof geocodeAddress;
  fetchFootprint: typeof fetchFootprintByBin;
  fetchNeighbors: typeof fetchNeighbors;
  now: () => number;
}

const defaultDeps: PlanDeps = {
  geocode: geocodeAddress,
  fetchFootprint: fetchFootprintByBin,
  fetchNeighbors,
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
};

/**
 * How long the neighbour lookup gets before the plan goes out without it.
 *
 * The measured query is ~0.6-1.3 s. The enclosure notes are worth roughly a
 * second of the ~1 s geometry pipeline, but they are an annotation on the
 * result, not the result — so a slow open-data service delays nothing.
 */
const NEIGHBOR_TIMEOUT_MS = 4000;

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

    // 4. Geometry math (pure, real): elevation (both datums) + four cameras
    //    aimed along the building's own facades where the footprint supports it.
    const elevation = estimateFloorElevation(footprint, floor);
    const eyeAboveGroundM =
      elevation.eyeElevationNavd88M - footprint.groundElevationNavd88M;
    const placed = buildCameraViews(
      footprint,
      elevation.eyeElevationEllipsoidalM,
      eyeAboveGroundM,
    );

    // 5. Per-direction enclosure, from neighbouring footprints. Degrades to
    //    null — "no notes available" — and never to a missing or altered
    //    result. Never to "open", either: an unknown surroundings is not an
    //    open view, and the UI says nothing rather than implying either.
    const neighborhood = await resolveNeighborhood(d, footprint, signal);

    // 6. Re-place any camera that would have stood inside the building across a
    //    light court, and re-measure from where it actually ends up.
    //
    //    Two passes rather than one because the court can only be measured once
    //    the cameras exist, and the cameras can only be corrected once the court
    //    is measured. It is bounded at two: the second pass moves cameras
    //    strictly closer to their own wall, into ground the first pass already
    //    proved is open, so it cannot discover a new court. Costs no network —
    //    the neighbour rows are fetched once and both passes are pure.
    let { views, basis, concentration } = placed;
    let confidence = neighborhood
      ? assessConfidence({
          views,
          eyeElevationNavd88M: elevation.eyeElevationNavd88M,
          subjectBin: footprint.bin,
          subjectGroundElevationNavd88M: footprint.groundElevationNavd88M,
          neighbors: neighborhood.neighbors,
          neighborDataIncomplete: neighborhood.incomplete,
        })
      : null;

    if (confidence && neighborhood) {
      const offsets = courtOffsets(confidence);
      if (Object.keys(offsets).length > 0) {
        const repositioned = buildCameraViews(
          footprint,
          elevation.eyeElevationEllipsoidalM,
          eyeAboveGroundM,
          undefined,
          offsets,
        );
        views = repositioned.views;
        basis = repositioned.basis;
        concentration = repositioned.concentration;
        confidence = mergeCourtFindings(
          confidence,
          assessConfidence({
            views,
            eyeElevationNavd88M: elevation.eyeElevationNavd88M,
            subjectBin: footprint.bin,
            subjectGroundElevationNavd88M: footprint.groundElevationNavd88M,
            neighbors: neighborhood.neighbors,
            neighborDataIncomplete: neighborhood.incomplete,
          }),
        );
      }
    }

    const plan: ViewPlan = {
      address,
      floor,
      geocode: geo,
      footprint,
      eyeElevationNavd88M: elevation.eyeElevationNavd88M,
      eyeElevationEllipsoidalM: elevation.eyeElevationEllipsoidalM,
      geoidHeightM: elevation.geoidHeightM,
      floorClampedToRoof: elevation.clampedToRoof,
      basis,
      facadeConcentration: concentration,
      views,
      confidence,
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

/**
 * Fetch the neighbouring footprints, or return `null`.
 *
 * Everything here is best-effort by design: the four camera vantages are the
 * result, and the enclosure notes are an annotation on them. A failed,
 * timed-out or empty neighbour lookup therefore costs the visitor the notes and
 * nothing else. An abort propagates, because an aborted plan should not
 * continue at all.
 *
 * Returns the rows rather than a finished report because the caller measures
 * twice against the same rows — see the two-pass placement above.
 */
async function resolveNeighborhood(
  d: PlanDeps,
  footprint: BuildingFootprint,
  signal?: AbortSignal,
): Promise<NeighborSet | null> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), NEIGHBOR_TIMEOUT_MS);
  const onOuterAbort = () => timeout.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    return await d.fetchNeighbors(
      footprint.centroid.lat,
      footprint.centroid.lng,
      SEARCH_RADIUS_M,
      timeout.signal,
    );
  } catch (err) {
    if (signal?.aborted) throw err; // the whole request was superseded
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}
