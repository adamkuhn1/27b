#!/usr/bin/env node
// Failure-path proof for 27B.
//
// The product constraint is not only "real imagery when it works" — it is
// "never a fabricated scene, on ANY path". This harness walks the failure paths
// in a real browser and records what each one actually renders, so the claim can
// be checked rather than asserted:
//
//   1. address outside NYC            -> honest "not available" state
//   2. address with no building record-> honest "not available" state
//   3. no imagery key configured      -> honest "imagery source not configured"
//
// None of these cost a tile request: 1 and 2 never reach the renderer, and 3 is
// run against a second dev server started with an empty key.
//
// Usage:
//   node apps/27b/proof/run-failure-paths.mjs
//     PROOF_URL      dev server with a key    (default http://localhost:5187/)
//     PROOF_URL_NOKEY dev server with no key  (default http://localhost:5188/)

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "evidence");
mkdirSync(OUT, { recursive: true });

const WITH_KEY = process.env.PROOF_URL ?? "http://localhost:5187/";
const NO_KEY = process.env.PROOF_URL_NOKEY ?? "http://localhost:5188/";

const CASES = [
  {
    name: "outside-nyc",
    url: WITH_KEY,
    address: "1 Infinite Loop, Cupertino, CA",
    floor: 3,
  },
  {
    name: "nyc-address-no-building-record",
    url: WITH_KEY,
    address: "1 Central Park, Manhattan, New York, NY",
    floor: 3,
  },
  {
    name: "no-imagery-key",
    url: NO_KEY,
    address: "350 5th Ave, Manhattan, New York, NY 10118",
    floor: 27,
  },
];

const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
try {
  for (const c of CASES) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
    let tileHostRequests = 0;
    page.on("request", (r) => {
      if (r.url().includes("tile.googleapis.com")) tileHostRequests += 1;
    });
    await page.goto(c.url, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.fill("#addr", c.address);
    await page.fill("#floor", String(c.floor));
    await page.click('button[type="submit"]');

    // Either an unavailable state or a rendered/blank result appears.
    await page
      .waitForSelector(".state, .view__canvas", { timeout: 60_000 })
      .catch(() => {});
    await page.waitForTimeout(2500);

    const stateText = (await page.textContent(".state").catch(() => null))?.trim();
    const imgCount = await page.locator(".view img.view__canvas").count();
    const canvasCount = await page.locator("canvas").count();
    await page.screenshot({ path: join(OUT, `failure-${c.name}.png`), fullPage: true });
    await page.close();

    results.push({
      case: c.name,
      address: c.address,
      floor: c.floor,
      stateText: stateText?.replace(/\s+/g, " ").slice(0, 400) ?? null,
      renderedImageFrames: imgCount,
      liveCanvasElements: canvasCount,
      tileHostRequests,
    });
  }
} finally {
  await browser.close();
}

writeFileSync(
  join(OUT, "failure-paths.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2),
);
for (const r of results) {
  console.log(`\n=== ${r.case} ===`);
  console.log(`address              : ${r.address} (floor ${r.floor})`);
  console.log(`tile.googleapis.com  : ${r.tileHostRequests} requests`);
  console.log(`rendered image frames: ${r.renderedImageFrames}`);
  console.log(`live <canvas> in DOM : ${r.liveCanvasElements}`);
  console.log(`state text           : ${r.stateText ?? "(none)"}`);
}
console.log(`\nEvidence written to ${OUT}`);
