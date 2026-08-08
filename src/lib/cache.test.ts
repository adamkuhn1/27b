import { describe, it, expect, beforeEach } from "vitest";
import {
  PLAN_ALGORITHM_INPUTS,
  PLAN_ALGORITHM_VERSION,
  algorithmVersionFor,
  cacheKey,
  clearCache,
  purgeSupersededPlans,
  readPlan,
  writePlan,
} from "./cache";
import {
  ASSUMED_FLOOR_HEIGHT_M,
  EYE_ABOVE_FLOOR_M,
  FACADE_CONCENTRATION_MIN,
  FACADE_OFFSET_M,
} from "./geometry";
import { CONE_HALF_ANGLE_DEG, SEARCH_RADIUS_M } from "./confidence";
import { GEOID18_NYC } from "./geoid";
import type { ViewPlan } from "./types";

/** A minimal in-memory localStorage so the cache layer works in Node. */
function installLocalStorage(): Map<string, string> {
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
  return map;
}

const PLAN = { address: "1 W 72nd St", floor: 7 } as unknown as ViewPlan;

let store: Map<string, string>;
beforeEach(() => {
  store = installLocalStorage();
  clearCache();
});

describe("plan cache round trip", () => {
  it("returns what it stored, for the same address and floor", () => {
    writePlan("1 W 72nd St", 7, PLAN);
    expect(readPlan("1 W 72nd St", 7)).toEqual(PLAN);
  });

  it("normalises spacing and case in the key", () => {
    writePlan("1 W 72nd St", 7, PLAN);
    expect(readPlan("  1  w 72ND st ", 7)).toEqual(PLAN);
  });

  it("does not answer for a different floor", () => {
    writePlan("1 W 72nd St", 7, PLAN);
    expect(readPlan("1 W 72nd St", 8)).toBeNull();
  });
});

describe("algorithm version", () => {
  it("is part of the storage key", () => {
    expect(cacheKey("1 W 72nd St", 7)).toContain(PLAN_ALGORITHM_VERSION);
  });

  it("is the fingerprint of the inputs this build actually ships", () => {
    expect(PLAN_ALGORITHM_VERSION).toBe(algorithmVersionFor(PLAN_ALGORITHM_INPUTS));
  });

  it("is fingerprinted from the live constants, not re-typed copies", () => {
    // If somebody hardcodes a number here instead of importing it, the tuning
    // constant can move without the cache noticing. These identities are what
    // makes the version couple to the algorithm rather than to a literal.
    expect(PLAN_ALGORITHM_INPUTS.geometry).toEqual({
      ASSUMED_FLOOR_HEIGHT_M,
      EYE_ABOVE_FLOOR_M,
      FACADE_OFFSET_M,
      FACADE_CONCENTRATION_MIN,
    });
    expect(PLAN_ALGORITHM_INPUTS.confidence.SEARCH_RADIUS_M).toBe(SEARCH_RADIUS_M);
    expect(PLAN_ALGORITHM_INPUTS.confidence.CONE_HALF_ANGLE_DEG).toBe(
      CONE_HALF_ANGLE_DEG,
    );
    expect(PLAN_ALGORITHM_INPUTS.geoid.grid).toBe(GEOID18_NYC);
  });

  it("changes when any geometry constant changes", () => {
    const moved = {
      ...PLAN_ALGORITHM_INPUTS,
      geometry: { ...PLAN_ALGORITHM_INPUTS.geometry, FACADE_OFFSET_M: 7 },
    };
    expect(algorithmVersionFor(moved)).not.toBe(PLAN_ALGORITHM_VERSION);
  });

  it("changes when an enclosure threshold changes", () => {
    const moved = {
      ...PLAN_ALGORITHM_INPUTS,
      confidence: { ...PLAN_ALGORITHM_INPUTS.confidence, SEARCH_RADIUS_M: 221 },
    };
    expect(algorithmVersionFor(moved)).not.toBe(PLAN_ALGORITHM_VERSION);
  });

  it("changes when the geoid lattice changes", () => {
    const grid = GEOID18_NYC.map((row) => [...row]);
    grid[0][0] += 0.001;
    const moved = { ...PLAN_ALGORITHM_INPUTS, geoid: { ...PLAN_ALGORITHM_INPUTS.geoid, grid } };
    expect(algorithmVersionFor(moved)).not.toBe(PLAN_ALGORITHM_VERSION);
  });

  it("changes when the revision is bumped with no constant moving", () => {
    const moved = { ...PLAN_ALGORITHM_INPUTS, revision: PLAN_ALGORITHM_INPUTS.revision + 1 };
    expect(algorithmVersionFor(moved)).not.toBe(PLAN_ALGORITHM_VERSION);
  });

  it("is stable for identical inputs", () => {
    expect(algorithmVersionFor({ ...PLAN_ALGORITHM_INPUTS })).toBe(
      PLAN_ALGORITHM_VERSION,
    );
  });
});

describe("a plan from a superseded algorithm is never served", () => {
  it("ignores an entry under an older version key", () => {
    const older = `27b:cache:v4-deadbeef:1 w 72nd st::7`;
    store.set(older, JSON.stringify({ v: "v4-deadbeef", savedAt: Date.now(), plan: PLAN }));
    expect(readPlan("1 W 72nd St", 7)).toBeNull();
  });

  it("ignores an entry at the current key whose envelope version disagrees", () => {
    // Defence in depth: the key already carries the version, so this can only
    // happen if something wrote the entry by hand. It still must not be served.
    store.set(
      cacheKey("1 W 72nd St", 7),
      JSON.stringify({ v: "v4-deadbeef", savedAt: Date.now(), plan: PLAN }),
    );
    expect(readPlan("1 W 72nd St", 7)).toBeNull();
  });

  it("ignores a corrupt entry rather than throwing", () => {
    store.set(cacheKey("1 W 72nd St", 7), "{not json");
    expect(readPlan("1 W 72nd St", 7)).toBeNull();
  });

  it("purges superseded generations and keeps the current one", () => {
    store.set("27b:cache:v4-deadbeef:1 w 72nd st::7", "{}");
    store.set("27b:cache:v3-01234567:350 5th ave::80", "{}");
    writePlan("1 W 72nd St", 7, PLAN);

    purgeSupersededPlans();

    expect([...store.keys()]).toEqual([cacheKey("1 W 72nd St", 7)]);
    expect(readPlan("1 W 72nd St", 7)).toEqual(PLAN);
  });

  it("leaves non-plan 27B keys alone", () => {
    store.set("27b:something-else", "keep me");
    purgeSupersededPlans();
    expect(store.get("27b:something-else")).toBe("keep me");
  });
});
