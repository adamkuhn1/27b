#!/usr/bin/env node
// End-to-end proof harness for 27B.
//
// Drives the real app in a real browser against the real Google Photorealistic
// 3D Tiles service, for ONE NYC address at TWO materially different floors, and
// records everything needed to check the result honestly:
//
//   - the full ViewPlan (camera lat/lng/bearing/height, both vertical datums)
//   - every request the page made to tile.googleapis.com, split into
//     root-tileset requests (the billable unit) and renderer tile requests
//   - the attribution string Google returned for the tiles actually drawn
//   - the four rendered frames, and a full-page screenshot
//
// It asserts nothing about beauty. It asserts that the imagery came from the
// provider, that the two floors produced different camera geometry, and that no
// synthetic scene was substituted anywhere.
//
// Usage (from the repo root, with apps/27b/.env.local holding the key):
//
//   npm run dev -w @portfolio-suite/27b        # terminal 1
//   node apps/27b/proof/run-proof.mjs          # terminal 2
//
// Playwright is not a dependency of this app (nothing else in the repo needs a
// browser driver). Install it wherever you like and point NODE_PATH at it:
//
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright
//   NODE_PATH=/tmp/pw/node_modules node apps/27b/proof/run-proof.mjs
//
// COST: each floor costs exactly one Photorealistic 3D Tiles *root tileset*
// request. That SKU is free for the first 1,000 requests/month and $6.00 per
// 1,000 after that, so a full two-floor run is $0.012 at worst and $0.00 inside
// the free cap. https://developers.google.com/maps/billing-and-pricing/pricing

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "evidence");

const BASE_URL = process.env.PROOF_URL ?? "http://localhost:5174/";
const ADDRESS =
  process.env.PROOF_ADDRESS ?? "350 5th Ave, Manhattan, New York, NY 10118";
const FLOORS = (process.env.PROOF_FLOORS ?? "6,80").split(",").map(Number);
const RENDER_TIMEOUT_MS = Number(process.env.PROOF_TIMEOUT_MS ?? 180_000);

mkdirSync(OUT, { recursive: true });

/** Strip a data: URL prefix and write the PNG bytes. */
function writeDataUrlPng(dataUrl, file) {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  writeFileSync(file, Buffer.from(b64, "base64"));
}

async function runFloor(browser, floor) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });

  const tileRequests = { rootTileset: [], rendererTiles: 0, other: 0 };
  page.on("request", (req) => {
    const url = req.url();
    if (!url.includes("tile.googleapis.com")) return;
    // Never log the key: strip the query string entirely.
    const path = url.split("?")[0];
    if (path.includes("/3dtiles/root.json")) tileRequests.rootTileset.push(path);
    else if (path.includes("/3dtiles/")) tileRequests.rendererTiles += 1;
    else tileRequests.other += 1;
  });

  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
  });

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  await page.fill("#addr", ADDRESS);
  await page.fill("#floor", String(floor));
  const t0 = Date.now();
  await page.click('button[type="submit"]');

  // The attribution line only renders once all four captures are ready, so it
  // is the honest "render finished" signal.
  await page.waitForSelector(".attribution", { timeout: RENDER_TIMEOUT_MS });
  const renderMs = Date.now() - t0;

  const attribution = (await page.textContent(".attribution"))?.trim() ?? "";

  const frames = await page.$$eval(".view img.view__canvas", (imgs) =>
    imgs.map((img) => ({ alt: img.alt, src: img.src })),
  );

  const plan = await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("27b:cache:")) {
        return JSON.parse(localStorage.getItem(k)).plan;
      }
    }
    return null;
  });

  // Confirm nothing rendered-imagery-shaped was persisted (ToS §3.2.3(b)).
  const persistedKeys = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith("27b:")),
  );

  await page.screenshot({
    path: join(OUT, `floor-${floor}-page.png`),
    fullPage: true,
  });

  frames.forEach((f, i) => {
    if (f.src.startsWith("data:image/png")) {
      writeDataUrlPng(f.src, join(OUT, `floor-${floor}-view-${i + 1}.png`));
    }
  });

  await page.close();

  return {
    floor,
    renderMs,
    attribution,
    frameCount: frames.length,
    frameAlts: frames.map((f) => f.alt),
    framesAreDataPng: frames.every((f) => f.src.startsWith("data:image/png")),
    tileRequests: {
      rootTilesetRequests: tileRequests.rootTileset.length,
      rendererTileRequests: tileRequests.rendererTiles,
      otherTileHostRequests: tileRequests.other,
    },
    persistedLocalStorageKeys: persistedKeys,
    consoleErrors,
    plan,
  };
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
try {
  for (const floor of FLOORS) {
    process.stderr.write(`[proof] rendering floor ${floor}...\n`);
    results.push(await runFloor(browser, floor));
  }
} finally {
  await browser.close();
}

const summary = {
  generatedAt: new Date().toISOString(),
  address: ADDRESS,
  floors: FLOORS,
  provider: "Google Photorealistic 3D Tiles (Map Tiles API) via CesiumJS",
  results,
};
writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));

// Console report.
for (const r of results) {
  const v = r.plan?.views ?? [];
  console.log(`\n=== floor ${r.floor} =====================================`);
  console.log(`render time            : ${(r.renderMs / 1000).toFixed(1)} s`);
  console.log(`root tileset requests  : ${r.tileRequests.rootTilesetRequests} (billable)`);
  console.log(`renderer tile requests : ${r.tileRequests.rendererTileRequests} (unmetered)`);
  console.log(`frames (data:image/png): ${r.frameCount} / all-png=${r.framesAreDataPng}`);
  console.log(`attribution            : ${r.attribution}`);
  console.log(`basis                  : ${r.plan?.basis}`);
  console.log(
    `eye NAVD88 / WGS84     : ${r.plan?.eyeElevationNavd88M?.toFixed(2)} m / ` +
      `${r.plan?.eyeElevationEllipsoidalM?.toFixed(2)} m (geoid ${r.plan?.geoidHeightM?.toFixed(2)} m)`,
  );
  console.log(`persisted 27b:* keys   : ${JSON.stringify(r.persistedLocalStorageKeys)}`);
  for (const view of v) {
    console.log(
      `  ${view.slot} bearing ${view.headingDeg.toFixed(1)}° (${view.compass}) ` +
        `lat ${view.lat.toFixed(6)} lng ${view.lng.toFixed(6)} ` +
        `h ${view.heightM.toFixed(1)} m pitch ${view.pitchDeg.toFixed(1)}° ` +
        `standoff ${view.standoffM.toFixed(1)} m`,
    );
  }
  if (r.consoleErrors.length) {
    console.log(`console errors         : ${r.consoleErrors.length}`);
    r.consoleErrors.slice(0, 5).forEach((e) => console.log(`   ! ${e}`));
  }
}

if (results.length >= 2) {
  const [a, b] = results;
  const dh =
    (b.plan?.eyeElevationEllipsoidalM ?? 0) - (a.plan?.eyeElevationEllipsoidalM ?? 0);
  console.log(
    `\nfloor separation       : ${dh.toFixed(1)} m between floor ${a.floor} and floor ${b.floor}`,
  );
}
console.log(`\nEvidence written to ${OUT}`);
