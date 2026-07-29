// Address-keyed cache for geocode + footprint results.
//
// Why this matters beyond speed: the raw Google Photorealistic 3D Tiles render
// is the only metered resource in the pipeline (free to ~1,000 tile-events/mo).
// Caching the *geometry* (geocode + footprint + camera plan) means a repeat
// lookup of the same (address, floor) never re-hits GeoSearch/Socrata and, more
// importantly, lets the viewer serve a previously captured render instead of
// re-streaming tiles. The cache is the mechanism that keeps the free tile cap
// viable — see README "Cost-cap notes".
//
// Storage: localStorage (synchronous, simple, survives reload). Values are
// namespaced + versioned so a schema change invalidates old entries cleanly.

import type { ViewPlan } from "./types";

const NAMESPACE = "27b:cache:v1";
/** Bump when the ViewPlan shape or geometry math changes. */
const SCHEMA_VERSION = 1;

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

// ---- Rendered-capture cache -------------------------------------------------
//
// The four static PNG captures are the expensive artifact (they cost tile
// events to produce). Cache them per (BIN, floor) so a repeat lookup of the same
// building+floor renders ZERO tiles. Kept in a separate namespace from plans
// because captures are large (data URLs) and may need eviction independently.

const CAPTURE_NS = "27b:captures:v1";

/** Map of cardinal -> PNG data URL. */
export type CaptureMap = Partial<Record<string, string>>;

interface CaptureEnvelope {
  v: number;
  savedAt: number;
  captures: CaptureMap;
}

export function captureKey(bin: string, floor: number): string {
  return `${CAPTURE_NS}:${bin}::${floor}`;
}

export function readCaptures(bin: string, floor: number): CaptureMap | null {
  const store = storage();
  if (!store) return null;
  const raw = store.getItem(captureKey(bin, floor));
  if (!raw) return null;
  try {
    const env = JSON.parse(raw) as CaptureEnvelope;
    if (env.v !== SCHEMA_VERSION || !env.captures) return null;
    return env.captures;
  } catch {
    return null;
  }
}

export function writeCaptures(
  bin: string,
  floor: number,
  captures: CaptureMap,
): void {
  const store = storage();
  if (!store) return;
  const env: CaptureEnvelope = {
    v: SCHEMA_VERSION,
    savedAt: Date.now(),
    captures,
  };
  try {
    store.setItem(captureKey(bin, floor), JSON.stringify(env));
  } catch {
    // Capture data URLs are large; quota errors are expected and acceptable.
  }
}

/** Clear all 27B cache entries (used by tests + a UI "clear cache" action). */
export function clearCache(): void {
  const store = storage();
  if (!store) return;
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    // Both plan (27b:cache:) and capture (27b:captures:) namespaces.
    if (k && k.startsWith("27b:")) keys.push(k);
  }
  keys.forEach((k) => store.removeItem(k));
}
