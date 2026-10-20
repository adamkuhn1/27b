// The frontend's connection to the planning backend: two fetch calls.
// planView() calls POST /api/view-plan and reshapes the backend's flat JSON
// body into the discriminated ViewPlanResult union the rest of the app
// (App.tsx, ResultView.tsx, States.tsx) consumes.
//
// In dev, `/api` is proxied to the backend by vite.config.ts, so this never
// needs to know the backend's host or worry about CORS.

import type { CuratedBuilding, UnavailableReason, ViewPlan, ViewPlanResult } from "./types";

/** Raw shape of a POST /api/view-plan response body (backend/models.py's
 *  ViewPlanResponse, camelCase on the wire either way). */
interface RawViewPlanResponse {
  ok: boolean;
  plan?: ViewPlan;
  reason?: UnavailableReason;
  message?: string;
  supportedFloors?: { min: number; max: number };
}

/**
 * Resolve an address + floor into a camera plan, or an honest unavailable
 * result. `address` and `floor` are assumed already validated by the form
 * (see ui/AddressForm.tsx), same contract the in-process pipeline had.
 */
export async function planView(
  address: string,
  floor: number,
  signal?: AbortSignal,
): Promise<ViewPlanResult> {
  let res: Response;
  let data: RawViewPlanResponse;
  try {
    res = await fetch("/api/view-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, floor }),
      signal,
    });

    if (!res.ok) {
      // The backend only ever returns non-200 for something outside the
      // domain model (a malformed request, a genuine bug) -- see
      // backend/models.py's ViewPlanResponse docstring. Route it to the same
      // honest unavailable state as every other failure, never a fake scene.
      return NETWORK_ERROR;
    }

    data = (await res.json()) as RawViewPlanResponse;
  } catch (err) {
    // A superseded lookup must still reject, so App.tsx can drop it.
    if (signal?.aborted) throw err;
    // Backend unreachable (fetch rejects) or a non-JSON body (e.g. a proxy
    // error page). Without this the rejection leaves the UI stuck in its
    // "planning" state with the form disabled.
    return NETWORK_ERROR;
  }

  return data.ok
    ? { ok: true, plan: data.plan! }
    : {
        ok: false,
        reason: data.reason ?? "network-error",
        message: data.message ?? NETWORK_ERROR.message,
        supportedFloors: data.supportedFloors,
      };
}

const NETWORK_ERROR = {
  ok: false,
  reason: "network-error",
  message: "Something went wrong resolving this address. Please try again.",
} as const satisfies ViewPlanResult;

/** The supported-building list the picker chips render (GET
 *  /api/curated-buildings). Fetched once, in App.tsx, and passed down --
 *  see ui/AddressForm.tsx and ui/States.tsx. */
export async function fetchCuratedBuildings(): Promise<CuratedBuilding[]> {
  const res = await fetch("/api/curated-buildings");
  if (!res.ok) return [];
  return (await res.json()) as CuratedBuilding[];
}
