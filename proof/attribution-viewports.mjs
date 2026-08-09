#!/usr/bin/env node
// Is Google's attribution fully visible at every viewport the app supports?
//
// Two things have to hold at once, and only one of them is CSS. The Map Tiles
// policies require the attributions for the tiles on screen to be displayed
// with the imagery; 27B satisfies that twice over — a line under the result,
// and the same credit composited into each frame's own pixels so it cannot be
// separated from the picture. Either can be lost: the line to a clipping
// ancestor, the baked bar to an `object-fit` that crops the frame.
//
// COST: one render session, total, for the whole sweep. The frames are
// captured once and held in React state as data URLs; resizing the viewport
// re-lays them out without re-rendering anything, so every viewport after the
// first is free. Do not restructure this into one navigation per viewport.
//
// Usage:
//   node apps/27b/proof/attribution-viewports.mjs --url=http://localhost:5292/

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { launchChrome, attachToPage, sleep } from "../../portfolio/qa/cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) =>
  argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=") ?? d;

const URL_BASE = arg("url", "http://localhost:5292/");
const ADDRESS = arg("address", "1 W 72nd St, Manhattan, New York, NY 10023");
const FLOOR = arg("floor", "7");
const OUT = arg("out", join(HERE, "attribution"));
const SHOTS = arg("shots", "");

const VIEWPORTS = [
  [320, 640],
  [375, 812],
  [768, 1024],
  [1024, 768],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
];

const MEASURE = `
JSON.stringify((() => {
  const clipped = (el) => {
    const r = el.getBoundingClientRect();
    for (let n = el.parentElement; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (!/hidden|clip|auto|scroll/.test(cs.overflow + cs.overflowX + cs.overflowY)) continue;
      const p = n.getBoundingClientRect();
      if (r.left < p.left - 0.5 || r.right > p.right + 0.5 ||
          r.top < p.top - 0.5 || r.bottom > p.bottom + 0.5) return n.className || n.tagName;
    }
    return null;
  };
  const line = document.querySelector(".attribution__line");
  const lr = line?.getBoundingClientRect();
  const frames = [...document.querySelectorAll("img.view__canvas, img.thumb__img")].map((img) => {
    const r = img.getBoundingClientRect();
    const fit = getComputedStyle(img).objectFit;
    const nw = img.naturalWidth, nh = img.naturalHeight;
    // The credit bar occupies the source rows below the 4:3 picture. Whatever
    // fraction of the source height the box shows is the fraction of the bar
    // that survives, and anything under 1 has eaten into the credit.
    let shown = 1, drawnHeight = r.height;
    if (nw && nh && r.width && r.height) {
      if (fit === "cover") {
        const s = Math.max(r.width / nw, r.height / nh);
        shown = Math.min(1, (r.height / s) / nh);
      } else if (fit === "contain" || fit === "scale-down") {
        const s = Math.min(r.width / nw, r.height / nh);
        drawnHeight = nh * s;
      }
    }
    // The baked bar's own height in the source, inferred from the overshoot
    // past 4:3, then scaled to how it is drawn.
    const barSourcePx = Math.max(0, nh - nw * 0.75);
    const scale = drawnHeight / nh;
    return {
      cls: img.className,
      natural: { w: nw, h: nh },
      box: { w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      objectFit: fit,
      verticalFractionShown: +shown.toFixed(4),
      creditFullyVisible: shown >= 0.9999,
      barCssPx: +(barSourcePx * scale).toFixed(2),
      barDevicePx: +(barSourcePx * scale * devicePixelRatio).toFixed(2),
      clippedBy: clipped(img),
    };
  });
  return {
    lineText: line?.textContent ?? null,
    lineVisible: Boolean(lr && lr.width > 0 && lr.height > 0),
    lineBox: lr ? { x: +lr.x.toFixed(1), y: +lr.y.toFixed(1), w: +lr.width.toFixed(1), h: +lr.height.toFixed(1) } : null,
    lineClippedBy: line ? clipped(line) : "missing",
    lineWithinDocument: lr ? lr.right <= document.documentElement.clientWidth + 0.5 && lr.left >= -0.5 : null,
    lineFontPx: line ? +parseFloat(getComputedStyle(line).fontSize).toFixed(2) : null,
    documentOverflowsX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 0.5,
    frames,
  };
})())
`;

mkdirSync(OUT, { recursive: true });
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const chrome = await launchChrome({ headless: true });
const out = { url: URL_BASE, address: ADDRESS, floor: Number(FLOOR), ranAt: new Date().toISOString(), viewports: [] };

try {
  const page = await attachToPage(chrome.port);
  await page.send("Runtime.enable");
  await page.send("Network.enable");

  let rootRequests = 0;
  page.on("Network.requestWillBeSent", ({ request }) => {
    if (request.url.includes("tile.googleapis.com") && request.url.includes("/3dtiles/root.json")) {
      rootRequests += 1;
    }
  });

  await page.viewport(1440, 1100);
  await page.goto(URL_BASE);
  await sleep(1200);
  await page.eval(`(() => {
    const set = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
      d.set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set(document.querySelector("#addr"), ${JSON.stringify(ADDRESS)});
    set(document.querySelector("#floor"), ${JSON.stringify(FLOOR)});
    document.querySelector(".form .btn").click(); return true;
  })()`);

  const deadline = Date.now() + 240000;
  let ready = 0;
  while (Date.now() < deadline) {
    await sleep(1500);
    ready = Number(await page.eval(`document.querySelectorAll("img.view__canvas, img.thumb__img").length`));
    const working = Number(
      await page.eval(
        `[...document.querySelectorAll(".plan__axis")].filter((g) => /queued|capturing/.test(g.className.baseVal || "")).length`,
      ),
    );
    if (ready > 0 && working === 0) break;
  }
  await sleep(1500);

  for (const [w, h] of VIEWPORTS) {
    await page.viewport(w, h);
    await sleep(700);
    const m = JSON.parse(await page.eval(MEASURE));
    out.viewports.push({ viewport: `${w}x${h}`, ...m });
    if (SHOTS) {
      const shot = await page.screenshot();
      writeFileSync(join(SHOTS, `attribution-${w}x${h}.png`), shot);
    }
  }

  out.provider = { rootTilesetRequests: rootRequests, worstCaseUsd: +(rootRequests * 0.006).toFixed(3) };
  writeFileSync(join(OUT, "report.json"), JSON.stringify(out, null, 2) + "\n");

  const bad = out.viewports.filter(
    (v) => !v.lineVisible || v.lineClippedBy || !v.lineWithinDocument || v.frames.some((f) => !f.creditFullyVisible || f.clippedBy),
  );
  console.error(`[attribution] ${join(OUT, "report.json")}`);
  console.error(`[attribution] ${out.viewports.length} viewport(s), ${bad.length} with a clipped or missing credit`);
  for (const v of out.viewports) {
    const smallest = Math.min(...v.frames.map((f) => f.barDevicePx));
    console.error(
      `  ${v.viewport.padEnd(9)} line ${v.lineVisible ? "visible" : "MISSING"} @${v.lineFontPx}px` +
        ` · ${v.frames.length} frame(s), all credits whole: ${v.frames.every((f) => f.creditFullyVisible)}` +
        ` · smallest baked bar ${smallest.toFixed(1)} device px`,
    );
  }
  console.error(`[attribution] ${rootRequests} billable session(s)`);
} finally {
  await chrome.close();
}
