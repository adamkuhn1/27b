#!/usr/bin/env node
// Arrange the frames a matrix pass already captured into one sheet per case, so
// every direction can be opened and looked at against the pre-registered rubric
// without hunting through a directory of 44 files.
//
// This touches no provider endpoint and costs nothing: it only lays out PNGs
// that are already on disk. It performs NO enhancement of any kind — no
// upscaling, no denoising, no sharpening, no generative fill. Each frame is
// drawn at its captured pixels, with the attribution bar the renderer baked
// into it, so the credit stays attached to the imagery in the composite exactly
// as it is in the source frame. The only added pixels are labels drawn OUTSIDE
// each frame.
//
// Output goes beside the frames, which is outside the repo: the frames are
// Google Maps Content and a sheet of them is the same Content rearranged.
//
// Usage:
//   node apps/27b/proof/contact-sheet.mjs <matrix-pass-dir>

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { attachToPage, sleep } from "../../portfolio/qa/cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(process.argv[2] ?? join(HERE, "eval-matrix", "pass-A"));
const report = JSON.parse(readFileSync(join(DIR, "report.json"), "utf8"));

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const rows = report.results
  .map((r) => {
    const cells = r.directions
      .map((d) => {
        const shot = d.shot && existsSync(d.shot) ? basename(d.shot) : null;
        return `<div class="cell">
          <div class="hd"><b>${esc(d.compass)}</b> · ${esc(d.bearing ?? "")}</div>
          <div class="meta">class <b>${esc(d.thumbQuality ?? d.leadQuality ?? "?")}</b> · state ${esc(
            d.leadPhase ?? (d.promoted === false ? "not-requested" : "?"),
          )}</div>
          ${
            shot
              ? `<img src="${esc(shot)}">`
              : `<div class="none">${esc(d.emptyFrameDescription ?? d.frameDescription ?? "no frame")}</div>`
          }
          <div class="note">${esc(d.note ?? "")}</div>
          <div class="px">${
            d.pixels
              ? `luma ${d.pixels.meanLuma} · sd ${d.pixels.sdLuma} · edge ${d.pixels.edgeEnergy}`
              : "&nbsp;"
          }</div>
        </div>`;
      })
      .join("");
    return `<section>
      <h2>${esc(r.case)} · floor ${r.floor} — ${esc(r.heading ?? r.address)}</h2>
      <p class="cat">${esc(r.category)}</p>
      <p class="cat">complete ${(r.settleMs / 1000).toFixed(1)}s · first direction ${
        r.timing?.firstDirectionMs == null
          ? "—"
          : (r.timing.firstDirectionMs / 1000).toFixed(1) + "s"
      } · attribution: ${esc(r.attribution ?? "none")}</p>
      <div class="grid">${cells}</div>
    </section>`;
  })
  .join("");

const html = `<!doctype html><meta charset="utf-8"><style>
  body { background:#fff; color:#111; font:13px/1.4 -apple-system,Helvetica,Arial,sans-serif; margin:0; padding:16px; width:1500px; }
  h1 { font-size:18px; margin:0 0 4px; }
  h2 { font-size:15px; margin:20px 0 2px; }
  .cat { margin:0 0 8px; color:#555; font-size:12px; }
  .grid { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; }
  .cell { border:1px solid #ccc; padding:6px; }
  .hd { font-size:12px; }
  .meta { font-size:11px; color:#555; margin-bottom:4px; }
  img { width:100%; display:block; }
  .none { height:120px; display:grid; place-items:center; text-align:center; font-size:11px; color:#666; background:#f4f4f4; padding:4px; }
  .note { font-size:11px; color:#333; margin-top:4px; min-height:28px; }
  .px { font-size:10px; color:#777; font-family:ui-monospace,monospace; }
</style>
<h1>27B — pass ${esc(report.pass)} · ${esc(report.ranAt)}</h1>
<p class="cat">Frames as captured. No enhancement of any kind. Each frame carries the
provider's attribution bar composited into its own pixels by the renderer.</p>
${rows}`;

const file = join(DIR, "contact-sheet.html");
writeFileSync(file, html);

const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9300 + Math.floor(Math.random() * 200);
const userDataDir = await mkdtemp(join(tmpdir(), "27b-sheet-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--allow-file-access-from-files",
    "about:blank",
  ],
  { stdio: "ignore" },
);

try {
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  const page = await attachToPage(port);
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1540,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.goto(`file://${file}`);
  await sleep(2500);

  // One image per case, because a single strip of twelve is unreadable at any
  // size a person can open.
  const boxes = JSON.parse(
    await page.eval(
      `JSON.stringify([...document.querySelectorAll("section")].map((s) => { const r = s.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height }; }))`,
    ),
  );
  for (let i = 0; i < boxes.length; i += 1) {
    const b = boxes[i];
    const r = report.results[i];
    const { data } = await page.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: b.x, y: b.y, width: b.w, height: b.h, scale: 1 },
    });
    const out = join(DIR, `sheet-${r.case}-f${r.floor}.png`);
    writeFileSync(out, Buffer.from(data, "base64"));
    console.error(`[sheet] ${out}`);
  }
} finally {
  chrome.kill();
  await sleep(400);
  await rm(userDataDir, { recursive: true, force: true, maxRetries: 5 });
}
