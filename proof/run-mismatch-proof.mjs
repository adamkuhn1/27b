#!/usr/bin/env node
// Address-substitution proof for 27B.
//
// The bug this guards against (found and fixed 2026-08-04, re-proven here):
// NYC Planning GeoSearch is Pelias, and Pelias ALWAYS returns a best candidate.
// For an address it cannot resolve it returns a fuzzy match carrying
// `confidence: 0.8, match_type: "fallback"` — byte-for-byte the same values a
// perfect hit returns. So confidence is not a usable signal, and an app that
// trusts it will render real Google imagery of a REAL BUT DIFFERENT BUILDING
// under the address the user typed. Real pixels, wrong place.
//
// A test that only checks "no imagery appeared" is weak: imagery might be
// absent for some unrelated reason. So for each case this harness records BOTH
// halves:
//
//   1. what GeoSearch offers when asked directly (the substitute building that
//      WAS available — its label, its BIN, its coordinates), and
//   2. what the app actually did with it (state text, frame count, live canvas
//      count, and every request to tile.googleapis.com).
//
// The proof is the pair: a real substitute existed, and the app rendered zero
// tiles and zero frames and said so instead.
//
// COST: $0.00. Every case is expected to make ZERO root-tileset requests. The
// harness fails loudly if any case makes even one, which would mean both a
// correctness bug and an unbudgeted charge.
//
// Usage:
//   npm run dev -w @portfolio-suite/27b
//   mkdir -p /tmp/pw && (cd /tmp/pw && npm i playwright)
//   NODE_PATH=/tmp/pw/node_modules node apps/27b/proof/run-mismatch-proof.mjs
//     PROOF_URL   dev server with a key configured (default http://localhost:5174/)

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "evidence");
mkdirSync(OUT, { recursive: true });

const BASE_URL = process.env.PROOF_URL ?? "http://localhost:5174/";
const GEOSEARCH = "https://geosearch.planninglabs.nyc/v2/search";

// Each of these resolves to a real, different NYC building in GeoSearch.
const CASES = [
  { name: "out-of-state-street-name", address: "1 Infinite Loop, Cupertino, CA", floor: 3 },
  { name: "nonexistent-brooklyn-street", address: "123 Fake Street, Brooklyn, NY", floor: 4 },
  { name: "nonexistent-queens-address", address: "77777 Imaginary Ave, Queens, NY", floor: 2 },
  { name: "foreign-address", address: "10 Downing Street, London", floor: 3 },
  { name: "transposed-house-number", address: "31-45 45th St, Astoria, Queens, NY", floor: 2 },
];

/** Ask GeoSearch directly: what substitute would a naive app have rendered? */
async function substituteAvailable(address) {
  try {
    const r = await fetch(`${GEOSEARCH}?text=${encodeURIComponent(address)}&size=1`);
    const j = await r.json();
    const f = j.features?.[0];
    if (!f) return { available: false };
    const p = f.properties;
    return {
      available: true,
      label: p.label,
      bin: p.addendum?.pad?.bin ?? null,
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
      confidence: p.confidence,
      matchType: p.match_type,
      parsedText: j.geocoding?.query?.parsed_text ?? null,
    };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
try {
  for (const c of CASES) {
    const substitute = await substituteAvailable(c.address);

    const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
    const tileRequests = [];
    page.on("request", (req) => {
      const url = req.url();
      if (!url.includes("tile.googleapis.com")) return;
      tileRequests.push(url.split("?")[0]); // never log the key
    });

    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.fill("#addr", c.address);
    await page.fill("#floor", String(c.floor));
    await page.click('button[type="submit"]');

    await page
      .waitForSelector(".state, .view__canvas", { timeout: 60_000 })
      .catch(() => {});
    // Give a wrong-building render every chance to start if it were going to.
    await page.waitForTimeout(4000);

    const stateText = (await page.textContent(".state").catch(() => null))?.trim();
    const frames = await page.locator(".view img.view__canvas").count();
    const canvases = await page.locator("canvas").count();
    const persisted = await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => k.startsWith("27b:")),
    );
    await page.screenshot({ path: join(OUT, `mismatch-${c.name}.png`), fullPage: true });
    await page.close();

    results.push({
      case: c.name,
      typedAddress: c.address,
      floor: c.floor,
      substituteGeoSearchWouldHaveGiven: substitute,
      appBehaviour: {
        stateText: stateText?.replace(/\s+/g, " ").slice(0, 400) ?? null,
        renderedImageFrames: frames,
        liveCanvasElements: canvases,
        tileHostRequests: tileRequests.length,
        rootTilesetRequests: tileRequests.filter((u) => u.includes("/3dtiles/root.json")).length,
        persistedLocalStorageKeys: persisted,
      },
    });
  }
} finally {
  await browser.close();
}

writeFileSync(
  join(OUT, "mismatch-proof.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl: BASE_URL, results }, null, 2),
);

let failures = 0;
for (const r of results) {
  const a = r.appBehaviour;
  const s = r.substituteGeoSearchWouldHaveGiven;
  console.log(`\n=== ${r.case} ===`);
  console.log(`typed                : ${r.typedAddress}`);
  console.log(
    `GeoSearch substitute : ${s.available ? `${s.label} (BIN ${s.bin}) conf ${s.confidence} / ${s.matchType}` : "none"}`,
  );
  console.log(`tile.googleapis.com  : ${a.tileHostRequests} requests (${a.rootTilesetRequests} billable)`);
  console.log(`rendered frames      : ${a.renderedImageFrames}`);
  console.log(`live <canvas>        : ${a.liveCanvasElements}`);
  console.log(`persisted 27b:* keys : ${JSON.stringify(a.persistedLocalStorageKeys)}`);
  console.log(`state text           : ${a.stateText ?? "(none)"}`);

  if (a.tileHostRequests !== 0) { console.log("FAIL: made tile requests for an unmatched address"); failures++; }
  if (a.renderedImageFrames !== 0) { console.log("FAIL: rendered image frames for an unmatched address"); failures++; }
  if (!a.stateText) { console.log("FAIL: no honest state message shown"); failures++; }
  if (!s.available) { console.log("WEAK: GeoSearch offered no substitute, so this case proves less than intended"); }
}

console.log(
  failures === 0
    ? `\nPASS — ${results.length} substitutable addresses, 0 tile requests, 0 frames, honest state every time.`
    : `\nFAIL — ${failures} assertion(s) failed.`,
);
console.log(`Evidence written to ${OUT}`);
process.exit(failures === 0 ? 0 : 1);
