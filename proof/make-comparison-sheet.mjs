#!/usr/bin/env node
// Compose a labelled side-by-side comparison sheet from frames already captured
// by run-proof.mjs.
//
// This does NOT touch the provider and costs nothing: it only arranges PNGs that
// are already on disk. It performs no enhancement of any kind — no upscaling, no
// generative fill, no colour grading, no sharpening. Each frame is drawn at its
// captured pixels with the attribution bar that run-proof.mjs baked into it, so
// the credits stay attached to the imagery in the composite exactly as they are
// in the source frame. The only added pixels are the labels drawn OUTSIDE each
// frame, which is the "real rendered frames plus separate UI annotation" rule.
//
// Output is written to evidence/ and is gitignored along with every other PNG.
//
// Usage:
//   NODE_PATH=/tmp/pw/node_modules node apps/27b/proof/make-comparison-sheet.mjs

import { createRequire } from "node:module";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "evidence");

const SLOTS = [
  { file: "view-1", bearing: "29.0° NNE" },
  { file: "view-2", bearing: "119.0° ESE" },
  { file: "view-3", bearing: "209.0° SSW" },
  { file: "view-4", bearing: "299.0° WNW" },
];

const ROWS = [
  {
    title: "Floor 6 — eye 17.5 m above ground (0.97 m WGS84 ellipsoidal)",
    prefix: "floor-6",
  },
  {
    title: "Floor 80 — eye 254.3 m above ground (237.77 m WGS84 ellipsoidal)",
    prefix: "floor-80",
  },
];

function dataUrl(file) {
  const p = join(OUT, `${file}.png`);
  if (!existsSync(p)) return null;
  return `data:image/png;base64,${readFileSync(p).toString("base64")}`;
}

const rowsHtml = ROWS.map((row) => {
  const cells = SLOTS.map((s) => {
    const src = dataUrl(`${row.prefix}-${s.file}`);
    return `<figure>
        ${src ? `<img src="${src}">` : `<div class="missing">missing ${row.prefix}-${s.file}.png</div>`}
        <figcaption>${s.bearing}</figcaption>
      </figure>`;
  }).join("");
  return `<section><h2>${row.title}</h2><div class="grid">${cells}</div></section>`;
}).join("");

const html = `<!doctype html><meta charset="utf-8"><style>
  body { margin:0; padding:28px; background:#0b0d10; color:#e8eaed;
         font:14px system-ui,-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; font-weight:600; }
  .sub { color:#9aa0a6; font-size:13px; margin:0 0 22px; line-height:1.5; max-width:1100px; }
  h2 { font-size:15px; font-weight:600; margin:22px 0 10px; color:#e8eaed; }
  .grid { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; }
  figure { margin:0; }
  img { width:100%; display:block; border:1px solid #2a2e33; }
  figcaption { color:#9aa0a6; font-size:12px; margin-top:5px; }
  .missing { aspect-ratio:800/629; display:grid; place-items:center;
             border:1px dashed #444; color:#888; font-size:12px; }
  footer { margin-top:26px; color:#9aa0a6; font-size:12px; line-height:1.6;
           border-top:1px solid #2a2e33; padding-top:14px; max-width:1100px; }
</style>
<h1>350 5th Avenue (Empire State Building) — floor 6 vs floor 80</h1>
<p class="sub">Same address, same four facade-derived bearings, same camera positions and pitch policy.
The only variable is eye altitude — a 236.8 m separation. Every frame is an unmodified Google
Photorealistic 3D Tiles render with its Google attribution composited into its own pixels.
No enhancement of any kind has been applied.</p>
${rowsHtml}
<footer>
Facade axis 29.0° derived from the building's own NYC Open Data footprint (BIN 1015862); bearings are
true compass. Imagery © Google. Attribution as shown in each frame.
This sheet arranges already-captured frames; it makes no provider requests and alters no pixels inside any frame.
</footer>`;

const page = await (await chromium.launch({ channel: "chrome", headless: true })).newPage({
  viewport: { width: 1720, height: 1400 },
  deviceScaleFactor: 1,
});
await page.setContent(html, { waitUntil: "load" });
const outFile = join(OUT, "comparison-esb-floor6-vs-floor80.png");
await page.screenshot({ path: outFile, fullPage: true });
await page.context().browser().close();

writeFileSync(
  join(OUT, "comparison-sheet.txt"),
  `Composed ${new Date().toISOString()} from local frames only. No provider requests. No pixel enhancement.\n`,
);
console.log(`Comparison sheet written to ${outFile}`);
