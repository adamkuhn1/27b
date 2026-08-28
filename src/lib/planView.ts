// The geometry pipeline: (address, floor) -> ViewPlan | honest unavailable.
//
// This orchestrates the real-data half end to end:
//
//   geocode -> verify match -> curated gate -> footprint -> elevation ->
//   facade-relative cameras
//
// Every failure path returns a structured `{ ok: false, reason }` that the UI
// renders as an honest unavailable state. There is deliberately NO code path
// here that fabricates coordinates, a building, or a scene: if real data is
// missing, the request is unavailable, full stop.
//
// The curated gate sits BEFORE the footprint fetch on purpose: an unsupported
// address costs one keyless geocode call and nothing else — no Open Data
// query, no Cesium session, no billable tile event.

import { geocodeAddress, GeocodeError } from "./geocode";
import { fetchFootprintByBin, FootprintError } from "./footprint";
import { estimateFloorElevation, buildCameraViews } from "./geometry";
import { curatedByBin } from "./curated";
import type { ViewPlan, ViewPlanResult, UnavailableReason } from "./types";

/** Injectable deps so the pipeline is unit-testable without network. */
export interface PlanDeps {
  geocode: typeof geocodeAddress;
  fetchFootprint: typeof fetchFootprintByBin;
}

const defaultDeps: PlanDeps = {
  geocode: geocodeAddress,
  fetchFootprint: fetchFootprintByBin,
};

function unavailable(
  reason: UnavailableReason,
  message: string,
  supportedFloors?: { min: number; max: number },
): ViewPlanResult {
  return { ok: false, reason, message, supportedFloors };
}

/**
 * Produce a ViewPlan for an address + floor, or an honest unavailable result.
 * `address` and `floor` are assumed already validated by the form.
 */
export async function planView(
  address: string,
  floor: number,
  signal?: AbortSignal,
  deps: Partial<PlanDeps> = {},
): Promise<ViewPlanResult> {
  const d: PlanDeps = { ...defaultDeps, ...deps };
  const started = Date.now();

  try {
    // 1. Geocode (NYC-only service doubles as the NYC gate) and verify the
    //    result really is the typed address (lib/addressMatch.ts).
    const geo = await d.geocode(address, signal);

    if (!geo.bin) {
      // No BIN means we can't join to a building footprint. Honest fail.
      return unavailable(
        "no-footprint",
        "We found the address but not a specific building record for it yet.",
      );
    }

    // 2. Curated gate. A real, verified NYC address that isn't on the
    //    supported list is a NOT-SUPPORTED result, stated plainly — the mesh
    //    quality ceiling is the provider's, and we don't show broken frames.
    const curated = curatedByBin(geo.bin);
    if (!curated) {
      return unavailable(
        "not-supported",
        `${geo.label} is a real address, but it isn't one of the buildings ` +
          `we've verified renders well.`,
      );
    }
    if (floor < curated.floors.min || floor > curated.floors.max) {
      return unavailable(
        "not-supported",
        `At ${curated.name} we've only verified good views from floors ` +
          `${curated.floors.min}-${curated.floors.max}.`,
        curated.floors,
      );
    }

    // 3. Footprint height + centroid (NYC Open Data — geometry, keyless).
    const footprint = await d.fetchFootprint(geo.bin, signal);

    // 4. Geometry math (pure, real): elevation in both datums + four cameras
    //    aimed along the building's own facades where the footprint supports
    //    it.
    const elevation = estimateFloorElevation(footprint, floor);
    const eyeAboveGroundM =
      elevation.eyeElevationNavd88M - footprint.groundElevationNavd88M;
    const { views, basis } = buildCameraViews(
      footprint,
      elevation.eyeElevationEllipsoidalM,
      eyeAboveGroundM,
    );

    const plan: ViewPlan = {
      address,
      floor,
      geocode: geo,
      footprint,
      curatedName: curated.name,
      eyeElevationNavd88M: elevation.eyeElevationNavd88M,
      eyeElevationEllipsoidalM: elevation.eyeElevationEllipsoidalM,
      geoidHeightM: elevation.geoidHeightM,
      floorClampedToRoof: elevation.clampedToRoof,
      basis,
      views,
    };

    // Draft instrumentation, console-only: the geometry half is expected to
    // resolve in ~1 s (two keyless HTTP calls + pure math). Not a UI panel —
    // an earlier metrics panel was decorative and crashed the app.
    console.debug(`[27b] plan resolved in ${Date.now() - started} ms`);
    return { ok: true, plan };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      // Caller cancelled (e.g. a new search). Re-throw so the UI can ignore.
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
