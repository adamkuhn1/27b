import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

// GHSA-55q2-fjhq-7xh7 (DOMPurify <= 3.4.12): when sanitizing with IN_PLACE and
// a hook that removes an element, _sanitizeElements returns before neutralizing
// the removed element's detached descendants, so event handlers on those
// descendants stay live and fire after sanitization. Patched in 3.4.13.
//
// 27B does not depend on DOMPurify directly; it arrives through
// cesium -> @cesium/engine -> dompurify. An earlier fix attempt used an
// npm `overrides` entry that resolved the package away entirely and broke the
// build, so this guard asserts BOTH halves of the fix: the package is really
// installed, and the installed version is past the advisory.
//
// This is a supply-chain assertion, not a source-string check: it reads the
// version that npm actually resolved into node_modules for this install.

const require = createRequire(import.meta.url);

/**
 * Read an installed package's manifest.
 *
 * `require("<pkg>/package.json")` is not usable here: DOMPurify ships an
 * `exports` map that does not expose `./package.json`, which Node enforces. So
 * resolve the package's entry point and walk up to the manifest that names it.
 */
function manifestOf(pkg: string): { name: string; version: string } & Record<string, unknown> {
  let dir = path.dirname(require.resolve(pkg));
  for (;;) {
    try {
      const parsed = JSON.parse(
        readFileSync(path.join(dir, "package.json"), "utf8"),
      );
      if (parsed?.name === pkg) return parsed;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no package.json found for ${pkg}`);
    dir = parent;
  }
}

/** Numeric compare of two dotted release versions (prerelease tags ignored). */
function compareRelease(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .split("-")[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10));
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** First version of DOMPurify carrying the GHSA-55q2-fjhq-7xh7 fix. */
const PATCHED = "3.4.13";

describe("DOMPurify advisory GHSA-55q2-fjhq-7xh7", () => {
  it("resolves a real installed dompurify (an override must not delete it)", () => {
    const manifest = manifestOf("dompurify");
    expect(typeof manifest.version).toBe("string");
    expect(manifest.version.length).toBeGreaterThan(0);
  });

  it("resolves a dompurify at or past the patched release", () => {
    const { version } = manifestOf("dompurify");
    expect(compareRelease(version, PATCHED)).toBeGreaterThanOrEqual(0);
  });

  it("keeps the resolved version inside the range @cesium/engine declares", () => {
    // A resolution that satisfies upstream's own range needs no override and
    // survives a fresh `npm install`. If Cesium ever narrows this range below
    // the patched release, this fails and the fix has to be re-derived.
    const engine = manifestOf("@cesium/engine") as unknown as {
      dependencies: Record<string, string>;
    };
    const range = engine.dependencies.dompurify;
    const caretFloor = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
    expect(caretFloor, `unhandled range shape: ${range}`).not.toBeNull();

    const [, major, minor, patch] = caretFloor as RegExpExecArray;
    const floor = `${major}.${minor}.${patch}`;
    const { version } = manifestOf("dompurify");

    // Same major (caret semantics) and at least the declared floor.
    expect(version.split(".")[0]).toBe(major);
    expect(compareRelease(version, floor)).toBeGreaterThanOrEqual(0);
    expect(compareRelease(PATCHED, floor)).toBeGreaterThanOrEqual(0);
  });

  it("has no DOMPurify call site in 27B's own source", () => {
    // The advisory is only reachable through a caller that opts into IN_PLACE.
    // 27B never calls DOMPurify at all; Cesium's single call site
    // (Credit.js `DOMPurify.sanitize(this._html)`) passes no config and Cesium
    // registers no hooks, so neither precondition is met. If 27B ever starts
    // sanitizing HTML itself, that reasoning has to be redone.
    const modules = import.meta.glob("../**/*.{ts,tsx}", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;

    const offenders = Object.entries(modules)
      .filter(([path]) => !path.includes("dompurifyAdvisory.test"))
      .filter(([, source]) => /\bDOMPurify\b|["']dompurify["']/.test(source))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });
});
