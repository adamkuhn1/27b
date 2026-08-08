// Address-keyed cache for geocode + footprint results.
//
// Why this matters beyond speed: the raw Google Photorealistic 3D Tiles render
// is the only metered resource in the pipeline (1,000 free root-tileset requests
// per month). Caching the *geometry* (geocode + footprint + camera plan) means a
// repeat lookup of the same (address, floor) never re-hits GeoSearch/Socrata.
//
// WHAT IS DELIBERATELY **NOT** CACHED: the rendered imagery. Google Maps
// Platform ToS §3.2.3(b) ("Customer will not cache Google Maps Content except as
// expressly permitted under the Maps Service Specific Terms") applies, and the
// Maps Service Specific Terms contain no Map Tiles API caching allowance —
// verified 2026-08-04, the document has no Map Tiles section at all. The Map
// Tiles API policies page repeats it ("you must not pre-fetch, index, store, or
// cache any Content") and separately prohibits "Offline uses". So rendered
// frames live only in the React state of the tab that produced them and are
// gone on reload. An earlier version of this file persisted PNG captures to
// localStorage per (BIN, floor); that was removed as a licence violation, not
// as an optimisation trade-off.
// Refs: https://cloud.google.com/maps-platform/terms (§3.2.3),
//       https://developers.google.com/maps/documentation/tile/policies
//
// Storage: localStorage (synchronous, simple, survives reload). Everything
// stored here is derived from NYC open data + our own math.
//
// WHAT MAKES AN ENTRY STALE
//
// A cached plan is not a copy of an answer someone else computed; it is the
// output of *this build's* geometry. Validating the shape is therefore not
// enough — a plan written before the facade standoff moved, or before the
// enclosure thresholds changed, still parses perfectly and still describes four
// cameras. It is simply the previous algorithm's answer, and a returning
// visitor would keep getting it indefinitely because nothing about it looks
// wrong.
//
// So the cache is keyed by an explicit algorithm version, and that version is
// COMPUTED FROM THE CONSTANTS THAT DETERMINE A PLAN rather than being a number
// somebody has to remember to bump. Change the facade offset, the assumed floor
// height, the field of view the enclosure cone is derived from, the geoid
// lattice, any of the enclosure thresholds — the fingerprint changes, every
// stored plan stops matching, and the next lookup recomputes. `PLAN_REVISION`
// below covers the remainder: math that changes without any of these numbers
// changing.

import type { ViewPlan } from "./types";
import {
  ASSUMED_FLOOR_HEIGHT_M,
  EYE_ABOVE_FLOOR_M,
  FACADE_CONCENTRATION_MIN,
  FACADE_OFFSET_M,
} from "./geometry";
import { GEOID18_NYC, GEOID_LAT0, GEOID_LON0, GEOID_STEP } from "./geoid";
import {
  ABUTTING_MIN_DEPTH_M,
  CONE_HALF_ANGLE_DEG,
  COURT_MIN_STANDOFF_M,
  EDGE_SAMPLE_STEP_M,
  ENCLOSED_MAX_FIRST_BLOCKING_M,
  ENCLOSED_MIN_ANGLE_DEG,
  OPEN_MAX_ANGLE_DEG,
  OPEN_MIN_FIRST_BLOCKING_M,
  SEARCH_RADIUS_M,
} from "./confidence";

/**
 * Stable prefix for every generation of the plan cache. It deliberately carries
 * no version of its own: `purgeSupersededPlans()` needs one prefix under which
 * it can find, and delete, the entries a previous algorithm left behind.
 */
const NAMESPACE = "27b:cache";

/** Bump when the stored `ViewPlan` shape changes. */
const SCHEMA_VERSION = 5;

/**
 * Bump when the geometry changes in a way none of the constants below express —
 * a corrected formula, a different placement rule, a new field derived from the
 * same inputs. The constants cover the tuning; this covers the code.
 */
const PLAN_REVISION = 1;

/**
 * Everything a stored plan depends on that can be read as a value.
 *
 * These are imported, never re-typed, so the fingerprint cannot drift away from
 * what the pipeline actually uses — `cache.test.ts` asserts the identity.
 */
export const PLAN_ALGORITHM_INPUTS = {
  schema: SCHEMA_VERSION,
  revision: PLAN_REVISION,
  geometry: {
    ASSUMED_FLOOR_HEIGHT_M,
    EYE_ABOVE_FLOOR_M,
    FACADE_OFFSET_M,
    FACADE_CONCENTRATION_MIN,
  },
  confidence: {
    SEARCH_RADIUS_M,
    CONE_HALF_ANGLE_DEG,
    ABUTTING_MIN_DEPTH_M,
    EDGE_SAMPLE_STEP_M,
    OPEN_MIN_FIRST_BLOCKING_M,
    OPEN_MAX_ANGLE_DEG,
    ENCLOSED_MAX_FIRST_BLOCKING_M,
    ENCLOSED_MIN_ANGLE_DEG,
    COURT_MIN_STANDOFF_M,
  },
  geoid: { GEOID_LAT0, GEOID_LON0, GEOID_STEP, grid: GEOID18_NYC },
} as const;

/**
 * FNV-1a, 32-bit. A hash is used rather than the raw values because the key has
 * to stay short and readable; this is a change detector, not a security
 * primitive, and a collision costs one visitor one stale plan.
 */
function fnv1a32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The version string for a given set of algorithm inputs. Exported for tests. */
export function algorithmVersionFor(inputs: unknown): string {
  return `v${SCHEMA_VERSION}-${fnv1a32(JSON.stringify(inputs))}`;
}

/**
 * The version this build writes and the only one it will read back. It appears
 * in the storage key, so a superseded generation can never be read, and in the
 * envelope, so an entry found in a browser says which algorithm produced it.
 */
export const PLAN_ALGORITHM_VERSION = algorithmVersionFor(PLAN_ALGORITHM_INPUTS);

interface CacheEnvelope {
  v: string;
  savedAt: number;
  plan: ViewPlan;
}

/** Normalize an address so trivial spacing/case differences hit the same key. */
export function cacheKey(address: string, floor: number): string {
  const norm = address.replace(/\s+/g, " ").trim().toLowerCase();
  return `${NAMESPACE}:${PLAN_ALGORITHM_VERSION}:${norm}::${floor}`;
}

/** Small guard so the app degrades gracefully where storage is unavailable. */
function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    // Touch it — Safari private mode throws on write.
    const probe = "__27b_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

/** Read a cached plan, or null on miss / corrupt / stale-schema entry. */
export function readPlan(address: string, floor: number): ViewPlan | null {
  const store = storage();
  if (!store) return null;
  const raw = store.getItem(cacheKey(address, floor));
  if (!raw) return null;
  try {
    const env = JSON.parse(raw) as CacheEnvelope;
    if (env.v !== PLAN_ALGORITHM_VERSION || !env.plan) return null;
    return env.plan;
  } catch {
    return null;
  }
}

/** Persist a plan. Silently no-ops where storage is unavailable/full. */
export function writePlan(address: string, floor: number, plan: ViewPlan): void {
  const store = storage();
  if (!store) return;
  const env: CacheEnvelope = { v: PLAN_ALGORITHM_VERSION, savedAt: Date.now(), plan };
  try {
    store.setItem(cacheKey(address, floor), JSON.stringify(env));
  } catch {
    // Quota exceeded or private mode — acceptable to skip caching.
  }
}

/**
 * Remove every 27B key from localStorage, including the retired
 * `27b:captures:*` namespace written by pre-2026-08-04 builds. Anyone who ran
 * the old build still has Google tile imagery sitting in their browser storage;
 * this runs on startup so that data is deleted rather than merely orphaned.
 */
export function purgeRetiredCaptureCache(): void {
  const store = storage();
  if (!store) return;
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k && k.startsWith("27b:captures:")) keys.push(k);
  }
  keys.forEach((k) => store.removeItem(k));
}

/**
 * Delete plan entries written by any algorithm version other than this build's.
 *
 * The version is part of the key, so a superseded entry is already unreadable —
 * this is about storage rather than correctness. Without it every change to the
 * geometry would leave a full generation of plans behind in a returning
 * visitor's browser, forever, since nothing would ever look them up again.
 */
export function purgeSupersededPlans(): void {
  const store = storage();
  if (!store) return;
  const current = `${NAMESPACE}:${PLAN_ALGORITHM_VERSION}:`;
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k && k.startsWith(`${NAMESPACE}:`) && !k.startsWith(current)) keys.push(k);
  }
  keys.forEach((k) => store.removeItem(k));
}

/** Clear all 27B cache entries (used by tests + a UI "clear cache" action). */
export function clearCache(): void {
  const store = storage();
  if (!store) return;
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k && k.startsWith("27b:")) keys.push(k);
  }
  keys.forEach((k) => store.removeItem(k));
}
