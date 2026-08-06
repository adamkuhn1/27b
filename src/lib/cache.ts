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
// Storage: localStorage (synchronous, simple, survives reload). Values are
// namespaced + versioned so a schema change invalidates old entries cleanly.
// Everything stored here is derived from NYC open data + our own math.

import type { ViewPlan } from "./types";

const NAMESPACE = "27b:cache:v4";
/** Bump when the ViewPlan shape or geometry math changes. */
const SCHEMA_VERSION = 4;

interface CacheEnvelope {
  v: number;
  savedAt: number;
  plan: ViewPlan;
}

/** Normalize an address so trivial spacing/case differences hit the same key. */
export function cacheKey(address: string, floor: number): string {
  const norm = address.replace(/\s+/g, " ").trim().toLowerCase();
  return `${NAMESPACE}:${norm}::${floor}`;
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
    if (env.v !== SCHEMA_VERSION || !env.plan) return null;
    return env.plan;
  } catch {
    return null;
  }
}

/** Persist a plan. Silently no-ops where storage is unavailable/full. */
export function writePlan(address: string, floor: number, plan: ViewPlan): void {
  const store = storage();
  if (!store) return;
  const env: CacheEnvelope = { v: SCHEMA_VERSION, savedAt: Date.now(), plan };
  try {
    store.setItem(cacheKey(address, floor), JSON.stringify(env));
  } catch {
    // Quota exceeded or private mode — acceptable to skip caching.
  }
}

/** Map of view slot -> PNG data URL, held in memory for the current render only. */
export type CaptureMap = Partial<Record<string, string>>;

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
