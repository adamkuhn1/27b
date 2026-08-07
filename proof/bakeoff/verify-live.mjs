#!/usr/bin/env node
// Final end-to-end verification of the selected configuration, through the real
// UI rather than through the bake-off driver.
//
// The bake-off imports the app's modules directly. That is the right tool for a
// parameter sweep, but it bypasses the form, the plan cache, the React state
// machine and the stylesheet — so on its own it cannot show that what a visitor
// sees is what was measured. This script types an address into the page, waits
// for the result, and records what actually reached the screen:
//
//   - the four bearings, and that they still match the plan's facade geometry
//   - the eye elevation, and that a different floor moves it
//   - every rendered frame's on-screen box and whether its baked attribution
//     bar survives the stylesheet
//   - the party-wall directions: that they render no image, cost no request,
//     and say why
//   - the root-tileset request count, from the network layer
//
// COST: one root tileset request per address+floor rendered.
//
//   node apps/27b/proof/bakeoff/verify-live.mjs

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { attachToPage, sleep } from "../../../portfolio/qa/cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "results");
const BASE_URL = process.env.BAKEOFF_URL ?? "http://localhost:5174/";
mkdirSync(join(OUT, "frames"), { recursive: true });

const CASES = [
  { id: "live-e79-fl10", address: "425 E 79th St, Manhattan", floor: 10 },
  { id: "live-dakota-fl3", address: "1 W 72nd St, Manhattan", floor: 3 },
];

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9400 + Math.floor(Math.random() * 500);
const udd = await mkdtemp(join(tmpdir(), "27b-verify-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${udd}`,
    "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--use-angle=metal", "--enable-gpu", "--force-device-scale-factor=1",
    "about:blank",
  ],
  { stdio: "ignore" },
);
for (let i = 0; i < 140; i++) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) break; } catch {}
  await sleep(150);
}
const page = await attachToPage(port);

let net = { rootTileset: 0, rendererTiles: 0 };
await page.send("Network.enable");
page.on("Network.requestWillBeSent", ({ request }) => {
  if (!request.url.includes("tile.googleapis.com")) return;
  const path = request.url.split("?")[0]; // never record the query: it holds the key
  if (path.includes("/3dtiles/root.json")) net.rootTileset += 1;
  else if (path.includes("/3dtiles/")) net.rendererTiles += 1;
});

const results = [];
for (const c of CASES) {
  net = { rootTileset: 0, rendererTiles: 0 };
  await page.viewport(1440, 1200, { dpr: 2 });
  await page.goto(BASE_URL);
  await page.eval(`localStorage.clear(); "cleared"`);
  await page.goto(BASE_URL);

  process.stderr.write(`[verify] ${c.id}\n`);
  await page.eval(`(() => {
    const set = (sel, v) => {
      const el = document.querySelector(sel);
      const proto = Object.getPrototypeOf(el);
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("#addr", ${JSON.stringify(c.address)});
    set("#floor", ${JSON.stringify(String(c.floor))});
    document.querySelector('button[type="submit"]').click();
    return "submitted";
  })()`);

  // Wait for every pane to reach a terminal state.
  //
  // NOT for `.attribution` to exist: the credit line is rebuilt from whatever
  // is on screen, so it appears the moment the FIRST frame lands. Waiting on it
  // measures a result that is one frame old and three frames unfinished — which
  // is exactly what the first run of this script did.
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 240_000) {
    ready = await page.eval(
      `Array.from(document.querySelectorAll(".view")).length > 0 &&
       Array.from(document.querySelectorAll(".view")).every(
         (f) => !["queued", "capturing"].includes(f.dataset.phase))`,
    );
    if (ready) break;
    await sleep(1000);
  }
  await sleep(1200); // let the last frame commit and lay out

  const observed = await page.eval(`(() => {
    const panes = Array.from(document.querySelectorAll(".view")).map((fig) => {
      const img = fig.querySelector("img.view__canvas");
      const empty = fig.querySelector(".view__canvas--empty");
      const box = (img ?? empty).getBoundingClientRect();
      let attributionVisible = null;
      if (img) {
        // The credit bar is baked into the bottom of the PNG. If the rendered
        // box is shorter than the natural image scaled to its width, the
        // stylesheet is cutting pixels off it.
        const scale = box.width / img.naturalWidth;
        const wanted = img.naturalHeight * scale;
        attributionVisible = { croppedCssPx: +(wanted - box.height).toFixed(2) };
      }
      return {
        compass: fig.querySelector(".view__compass")?.textContent?.trim(),
        bearing: fig.querySelector(".view__bearing")?.textContent?.trim(),
        phase: fig.dataset.phase,
        hasImage: !!img,
        natural: img ? [img.naturalWidth, img.naturalHeight] : null,
        boxCss: [+box.width.toFixed(1), +box.height.toFixed(1)],
        alt: img?.alt ?? empty?.getAttribute("aria-label") ?? null,
        note: fig.querySelector(".view__note")?.textContent?.trim() ?? null,
        attributionVisible,
      };
    });
    const plan = (() => {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("27b:cache:")) return JSON.parse(localStorage.getItem(k)).plan;
      }
      return null;
    })();
    return {
      attribution: document.querySelector(".attribution")?.textContent?.trim() ?? null,
      frameLine: document.querySelector(".result__frame")?.textContent?.trim() ?? null,
      subLine: document.querySelector(".result__sub")?.textContent?.trim() ?? null,
      notes: Array.from(document.querySelectorAll(".notes li")).map((li) => li.textContent.trim()),
      panes,
      persistedKeys: Object.keys(localStorage).filter((k) => k.startsWith("27b:")),
      plan: plan && {
        basis: plan.basis,
        eyeNavd88: plan.eyeElevationNavd88M,
        eyeWgs84: plan.eyeElevationEllipsoidalM,
        views: plan.views.map((v) => ({ slot: v.slot, headingDeg: v.headingDeg, standoffM: v.standoffM })),
        insideNeighborByM: plan.confidence
          ? Object.fromEntries(Object.entries(plan.confidence.bySlot).map(([k, v]) => [k, v.insideNeighborByM]))
          : null,
      },
    };
  })()`);

  // Keep one full-page screenshot per case as the visual record.
  const shot = await page.screenshot();
  writeFileSync(join(OUT, "frames", `${c.id}--page.png`), shot);

  results.push({ ...c, ready, wallMs: Date.now() - t0, net: { ...net }, observed });
  console.error(
    `[verify]   root=${net.rootTileset} tiles=${net.rendererTiles} ` +
      `panes=${observed.panes.map((p) => `${p.compass}:${p.phase}`).join(" ")}`,
  );
}

writeFileSync(
  join(OUT, "live-verification.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2),
);
console.error(`\n[verify] ${join(OUT, "live-verification.json")}`);

page.close();
chrome.kill("SIGTERM");
await sleep(400);
await rm(udd, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
