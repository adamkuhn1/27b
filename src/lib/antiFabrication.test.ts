// Structural guards on the one promise this project cannot break.
//
// The behavioural side of "no fabricated imagery" is covered by planView.test.ts
// (every failure reason routes to an honest unavailable state), by
// renderSession.test.ts (no failure path carries a dataUrl), and in a real
// browser by proof/run-progressive-proof.mjs (zero <img> and zero <canvas>
// anywhere in the result when nothing loaded).
//
// This file guards the *shape of the codebase* instead, because the realistic
// way this promise gets broken is not a bug — it is a well-meaning future edit.
// A placeholder gradient "so the grid doesn't look broken". An inline SVG city
// silhouette while tiles load. A CSS background on the empty pane. Each would
// pass every behavioural test in the repo and each would be a violation.
//
// These assertions are deliberately blunt and will occasionally be annoying.
// That is the trade: a test that has to be consciously edited is the point.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..");

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry === "__fixtures__") continue; // committed NYC open data, no code
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx|css)$/.test(entry)) continue;
      if (/\.test\.tsx?$/.test(entry)) continue; // tests may hold sample bytes
      out.push(p);
    }
  };
  walk(SRC);
  return out;
}

const files = sourceFiles().map((p) => ({
  path: relative(SRC, p),
  text: readFileSync(p, "utf8"),
}));

describe("no source file can produce an image", () => {
  it("contains no embedded image data anywhere", () => {
    // A `data:image/...` literal in product code is either a placeholder or a
    // logo. 27B needs neither, and it is the cheapest possible way to smuggle
    // a fabricated scene in.
    const offenders = files
      .filter((f) => /data:image\//.test(f.text.replace(/`<img src=data:\.\.\.>`/g, "")))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("renders <img> from exactly one component", () => {
    const withImg = files
      .filter((f) => f.path.endsWith(".tsx") && /<img\b/.test(f.text))
      .map((f) => f.path);
    expect(withImg).toEqual(["viewer/CesiumView.tsx"]);
  });

  it("gives that <img> a src from the capture and from nothing else", () => {
    const cesiumView = files.find((f) => f.path === "viewer/CesiumView.tsx")!;
    const srcs = [...cesiumView.text.matchAll(/src=\{([^}]+)\}/g)].map((m) =>
      m[1].trim(),
    );
    expect(srcs).toEqual(["slot.dataUrl"]);
  });

  it("uses no CSS background images", () => {
    // Covers `background: url(...)`, and therefore covers the "just a subtle
    // skyline behind the empty frames" edit.
    const offenders = files
      .filter((f) => f.path.endsWith(".css") && /url\(/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("draws SVG only in the plan diagram, which is drawn from NYC open data", () => {
    const withSvg = files
      .filter((f) => f.path.endsWith(".tsx") && /<svg\b/.test(f.text))
      .map((f) => f.path);
    expect(withSvg).toEqual(["ui/PlanDiagram.tsx"]);
  });

  it("keeps the plan diagram to the footprint ring and the camera views", () => {
    // Guards against the diagram growing invented context — neighbouring
    // blocks, a horizon line, a compass rose with a drawn skyline. Everything
    // it draws must come from `plan`.
    const diagram = files.find((f) => f.path === "ui/PlanDiagram.tsx")!;
    expect(diagram.text).toMatch(/plan\.footprint\.ring/);
    expect(diagram.text).not.toMatch(/Math\.random/);
    expect(diagram.text).not.toMatch(/<image\b/);
  });
});

describe("the renderer stays behind the key gate", () => {
  it("is imported dynamically, from exactly one place", () => {
    const importers = files
      .filter((f) => /import\(\s*["'][^"']*tileRenderer/.test(f.text))
      .map((f) => f.path);
    expect(importers).toEqual(["viewer/useTileCaptures.tsx"]);
  });

  it("is never imported statically, which would put Cesium in the entry chunk", () => {
    const staticImporters = files
      .filter(
        (f) =>
          f.path !== "viewer/tileRenderer.ts" &&
          /^\s*import\s[^(]*from\s+["'][^"']*tileRenderer["']/m.test(f.text),
      )
      .map((f) => f.path);
    expect(staticImporters).toEqual([]);
  });

  it("checks for a key before that import runs", () => {
    const provider = files.find((f) => f.path === "viewer/useTileCaptures.tsx")!;
    const keyCheck = provider.text.indexOf("if (!key)");
    const dynamicImport = provider.text.indexOf('import("./tileRenderer")');
    expect(keyCheck).toBeGreaterThan(-1);
    expect(dynamicImport).toBeGreaterThan(keyCheck);
  });
});

describe("provider imagery is never persisted", () => {
  it("writes nothing but the ViewPlan to storage", () => {
    const cache = files.find((f) => f.path === "lib/cache.ts")!;
    const writes = [...cache.text.matchAll(/setItem\(([^;]*?)\);/g)].map((m) =>
      m[1].replace(/\s+/g, " ").trim(),
    );
    // Exactly two: the storage-availability probe, and the plan envelope.
    expect(writes).toEqual([
      'probe, "1"',
      "cacheKey(address, floor), JSON.stringify(env)",
    ]);
    expect(cache.text).not.toMatch(/dataUrl/);
  });

  it("keeps captures out of every storage API", () => {
    const provider = files.find((f) => f.path === "viewer/useTileCaptures.tsx")!;
    for (const api of [
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "caches",
      "showSaveFilePicker",
    ]) {
      expect(provider.text, api).not.toContain(api);
    }
  });

  it("offers no download affordance for a captured frame", () => {
    const offenders = files
      .filter((f) => /download=|createObjectURL|\.click\(\)/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

describe("attribution cannot be separated from the pixels", () => {
  it("composites the credit line into every capture", () => {
    const renderer = files.find((f) => f.path === "viewer/tileRenderer.ts")!;
    // The only place a dataUrl is produced is the attribution compositor.
    expect(renderer.text).toMatch(/dataUrl = composeAttributedPng\(/);
    // Exactly one real `toDataURL` call, and it is the last line of the
    // attribution compositor — so no frame can be read back without its credit.
    const code = renderer.text
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect([...code.matchAll(/toDataURL\(/g)]).toHaveLength(1);
    expect(code).toMatch(/return out\.toDataURL\("image\/png"\);/);
    expect(renderer.text).toMatch(/GOOGLE_ATTRIBUTION = "Google Maps"/);
  });
});
