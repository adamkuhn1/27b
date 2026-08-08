#!/usr/bin/env node
// Do the five preset buttons actually produce a good result?
//
// The presets are the demo. Almost nobody types an address into a portfolio
// piece — they click the first button, look at the picture, maybe click a
// second direction, and form their whole opinion of the app from that. Every
// other harness in this directory either runs keyless (`shoot.mjs`, which
// cannot reach the renderer at all) or drives ONE address through the form
// (`run-proof.mjs`). Neither has ever looked at what the buttons on the
// landing page return.
//
// This one clicks each preset exactly as a visitor would, promotes all four
// directions, and writes down what came back: the phase and quality of every
// direction, the note the UI printed under it, the attribution Google
// returned, the pixel content of every frame, and every provider request made.
// It asserts the honesty properties. It does NOT assert beauty — the frames
// are written out so a person can look at them, because "great result" is not
// a thing a script can decide.
//
// COST. Photorealistic 3D Tiles bills the *root tileset* request; renderer tile
// requests within a session are not separately billed. One session per preset,
// so a full run of five presets is five billable requests. That SKU is free for
// the first 1,000/month and $6.00 per 1,000 after, i.e. $0.00 inside the cap and
// $0.03 at absolute worst. The run refuses to start if it would exceed
// --max-sessions, and it counts root requests as it goes.
// https://developers.google.com/maps/billing-and-pricing/pricing
//
// Usage (needs a server that has the key — dev reads apps/27b/.env.local):
//
//   npm run dev -w @portfolio-suite/27b
//   node apps/27b/proof/verify-presets.mjs --url=http://localhost:5174/
//
// Options: --out=<dir> --only=<substring> --max-sessions=<n> --dpr=<n>

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { attachToPage, sleep } from "../../portfolio/qa/cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback) =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;

const BASE_URL = arg("url", "http://localhost:5174/");
const OUT = arg("out", join(HERE, "presets"));
const ONLY = arg("only", "");
const MAX_SESSIONS = Number(arg("max-sessions", "8"));
const DPR = Number(arg("dpr", "2"));
const SETTLE_TIMEOUT_MS = Number(arg("timeout", "120000"));

mkdirSync(OUT, { recursive: true });

const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9600 + Math.floor(Math.random() * 300);
const userDataDir = await mkdtemp(join(tmpdir(), "27b-presets-"));

// Headed would be nicer to watch but steals focus for minutes at a time, and
// this runs while someone is using their machine. --headless=new still gives a
// real GPU-backed WebGL context via SwiftShader, which is what Cesium needs.
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--use-gl=angle",
    "--use-angle=metal",
    "--enable-unsafe-swiftshader",
    `--force-device-scale-factor=${DPR}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function waitForChrome() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return r.json();
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error("Chrome did not expose a debugging port");
}

/** Redact the key before anything is written to disk or printed. */
const scrub = (s) => String(s).replace(/([?&]key=)[^&]+/gi, "$1<redacted>");

const results = [];
let rootRequests = 0;
let rendererTiles = 0;

try {
  await waitForChrome();
  const page = await attachToPage(port);

  await page.send("Network.enable");
  await page.send("Runtime.enable");
  await page.send("Log.enable");

  const consoleErrors = [];
  page.on("Runtime.consoleAPICalled", (e) => {
    if (e.type !== "error" && e.type !== "warning") return;
    const text = e.args.map((a) => a.value ?? a.description ?? a.type).join(" ");
    consoleErrors.push({ level: e.type, text: scrub(text) });
  });
  page.on("Log.entryAdded", ({ entry }) => {
    if (entry.level !== "error" && entry.level !== "warning") return;
    consoleErrors.push({ level: entry.level, text: scrub(entry.text) });
  });

  page.on("Network.requestWillBeSent", ({ request }) => {
    if (!request.url.includes("tile.googleapis.com")) return;
    if (request.url.includes("/3dtiles/root.json")) {
      rootRequests += 1;
      if (rootRequests > MAX_SESSIONS) {
        throw new Error(
          `provider session budget exceeded: ${rootRequests} > --max-sessions=${MAX_SESSIONS}`,
        );
      }
    } else if (request.url.includes("/3dtiles/")) {
      rendererTiles += 1;
    }
  });

  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1100,
    deviceScaleFactor: DPR,
    mobile: false,
  });

  await page.goto(BASE_URL);
  await sleep(1500);

  // If no key is configured the app shows its honest "no imagery source" state
  // and every frame below would be empty for a reason that has nothing to do
  // with the presets. Fail here rather than produce five blank result sheets.
  const gate = await page.eval(`JSON.stringify({
    noSource: Boolean(document.querySelector("[data-state='no-imagery-source']"))
      || /imagery source/i.test(document.body.innerText),
    presets: [...document.querySelectorAll(".preset")].map((b) => ({
      name: b.querySelector(".preset__name")?.textContent ?? "",
      detail: b.querySelector(".preset__detail")?.textContent ?? "",
    })),
  })`);
  // Which GPU is actually behind the WebGL context. Not a detail: a software
  // rasteriser settles tiles far slower than a real GPU, and a run that blames
  // the app for a frame the harness starved is worse than no run. Recorded so
  // every number below can be read against it.
  const renderer = await page.eval(`(() => {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    if (!gl) return "no WebGL";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "renderer info unavailable";
  })()`);
  console.error(`[presets] WebGL renderer: ${renderer}`);

  const { noSource, presets } = JSON.parse(gate);
  if (noSource) throw new Error("app is in the no-imagery-source state — run against a keyed server");
  if (presets.length === 0) throw new Error("no .preset buttons found on the landing page");

  const wanted = presets
    .map((p, i) => ({ ...p, index: i }))
    .filter((p) => !ONLY || p.name.toLowerCase().includes(ONLY.toLowerCase()));

  console.error(
    `[presets] ${wanted.length} preset(s), budget ${MAX_SESSIONS} provider session(s)\n`,
  );

  for (const preset of wanted) {
    const slug = preset.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const beforeRoot = rootRequests;
    const beforeTiles = rendererTiles;
    const errorsAt = consoleErrors.length;
    const t0 = Date.now();

    // Back to the landing page for each preset. A fresh document is the only
    // way to be certain one preset's session is not still feeding the next
    // one's frames, which would make a broken preset look fine.
    await page.goto(BASE_URL);
    await sleep(1200);
    await page.eval(`(() => {
      const b = [...document.querySelectorAll(".preset")][${preset.index}];
      if (!b) throw new Error("preset ${preset.index} vanished");
      b.click();
      return true;
    })()`);

    // Settled = the session reached a terminal state. Observable from the DOM
    // without instrumenting the app: no direction is still queued or capturing.
    let settled = false;
    let failedState = null;
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(1000);
      // Per-slot phase, read off the plan diagram, which is the only place the
      // app puts it in the DOM (`.plan__axis--<phase>`). An earlier version of
      // this loop counted <img> elements against placeholder divs and called it
      // terminal at four — but a queued slot renders a placeholder too, so a
      // result with one picture and three spinners scored the same as a
      // finished one. It reported 1/4 and 2/4 results as settled.
      const s = await page.eval(`JSON.stringify((() => {
        // The honest failure state is terminal too, and it is not a hang: an
        // address the app cannot resolve is supposed to land here.
        const bad = document.querySelector(".state");
        if (bad) return {
          unavailable: {
            title: bad.querySelector(".state__title")?.textContent ?? null,
            body: bad.querySelector(".state__body")?.textContent ?? null,
          },
        };
        const lead = document.querySelector(".lead");
        if (!lead) return { none: true };
        const axes = [...document.querySelectorAll(".plan__axis")].map((g) =>
          (g.className.baseVal || "").replace(/.*plan__axis--/, ""));
        return {
          leadPhase: lead.getAttribute("data-phase"),
          axes,
          imgs: document.querySelectorAll(".thumb img").length,
          attribution: Boolean(document.querySelector(".attribution__line")),
        };
      })())`);
      const st = JSON.parse(s);
      if (st.unavailable) {
        settled = true;
        failedState = st.unavailable;
        break;
      }
      const working = (st.axes ?? []).filter((a) => a === "queued" || a === "capturing").length;
      if (!st.none && (st.axes ?? []).length >= 4 && working === 0) {
        settled = true;
        break;
      }
    }
    const settleMs = Date.now() - t0;
    await sleep(1500); // let the last tiles refine before we photograph it

    // Promote each direction in turn and record what the app says about it,
    // then photograph the lead frame on its own.
    const directions = [];
    const count = Number(await page.eval(`document.querySelectorAll(".thumb").length`));
    for (let i = 0; i < count; i += 1) {
      const disabled = await page.eval(
        `document.querySelectorAll(".thumb")[${i}].disabled === true`,
      );
      if (disabled !== true) {
        await page.eval(`(() => { document.querySelectorAll(".thumb")[${i}].click(); return true; })()`);
        await sleep(1400);
      }
      const d = JSON.parse(
        await page.eval(`JSON.stringify((() => {
          const thumb = document.querySelectorAll(".thumb")[${i}];
          const lead = document.querySelector(".lead");
          const img = lead?.querySelector("img");
          const r = lead?.getBoundingClientRect();
          return {
            compass: thumb?.querySelector(".thumb__compass")?.textContent ?? null,
            thumbState: thumb?.querySelector(".thumb__state")?.textContent ?? null,
            thumbQuality: thumb?.getAttribute("data-quality") ?? null,
            promoted: thumb?.disabled !== true,
            leadPhase: lead?.getAttribute("data-phase") ?? null,
            leadQuality: lead?.getAttribute("data-quality") ?? null,
            caption: lead?.querySelector(".lead__caption")?.innerText ?? null,
            note: lead?.querySelector(".lead__note")?.textContent ?? null,
            image: img
              ? { w: img.naturalWidth, h: img.naturalHeight, src: img.src.slice(0, 12) }
              : null,
            // Page coordinates, which is what Page.captureScreenshot's clip
            // wants. getBoundingClientRect is viewport-relative and the result
            // sits well below the fold, so the un-offset rect photographs the
            // masthead instead of the picture.
            rect: r
              ? { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height }
              : null,
          };
        })())`),
      );

      // Pixel statistics on the frame itself. A frame that rendered fog, sky or
      // the inside of a wall is uniform; a frame that shows a city is not. This
      // is the only automatic signal available for "is the picture any good",
      // and it is reported, never used to pass or fail.
      if (d.image) {
        d.pixels = JSON.parse(
          await page.eval(`JSON.stringify((() => {
            const img = document.querySelector(".lead img");
            try {
            const c = document.createElement("canvas");
            const W = 96, H = 64;
            c.width = W; c.height = H;
            const g = c.getContext("2d", { willReadFrequently: true });
            g.drawImage(img, 0, 0, W, H);
            const p = g.getImageData(0, 0, W, H).data;
            let n = 0, sum = 0, sumSq = 0;
            const lum = [];
            for (let k = 0; k < p.length; k += 4) {
              const l = 0.2126 * p[k] + 0.7152 * p[k + 1] + 0.0722 * p[k + 2];
              lum.push(l); sum += l; sumSq += l * l; n += 1;
            }
            const mean = sum / n;
            const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
            // Edge energy: mean absolute horizontal gradient. Detail, not contrast.
            let edge = 0, m = 0;
            for (let y = 0; y < H; y += 1)
              for (let x = 1; x < W; x += 1) { edge += Math.abs(lum[y*W+x] - lum[y*W+x-1]); m += 1; }
            return {
              meanLuma: +mean.toFixed(1),
              sdLuma: +sd.toFixed(1),
              edgeEnergy: +(edge / m).toFixed(2),
            };
            } catch (err) {
              // A cross-origin frame taints the canvas. Say so; do not let the
              // measurement's failure be mistaken for the frame's failure.
              return { unreadable: String(err && err.name) };
            }
          })())`),
        );
      }

      if (d.rect && d.rect.w > 0) {
        const { data } = await page.send("Page.captureScreenshot", {
          format: "png",
          clip: { x: d.rect.x, y: d.rect.y, width: d.rect.w, height: d.rect.h, scale: 1 },
        });
        const file = join(OUT, `${slug}-${i}-${(d.compass ?? "dir").toLowerCase()}.png`);
        writeFileSync(file, Buffer.from(data, "base64"));
        d.shot = file;
      }
      directions.push(d);
    }

    const summary = JSON.parse(
      await page.eval(`JSON.stringify((() => ({
        heading: document.querySelector(".result__addr")?.textContent ?? null,
        frameLine: document.querySelector(".result__frame")?.textContent ?? null,
        notes: [...document.querySelectorAll(".notes li")].map((n) => n.textContent),
        attribution: document.querySelector(".attribution__line")?.textContent ?? null,
        renderAgainOffered: Boolean(
          [...document.querySelectorAll("button")].some((b) => /again/i.test(b.textContent)),
        ),
      }))())`),
    );

    await page.eval(`window.scrollTo(0, 0)`);
    await sleep(300);
    const { data: full } = await page.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });
    const pageShot = join(OUT, `${slug}-page.png`);
    writeFileSync(pageShot, Buffer.from(full, "base64"));

    const record = {
      preset: preset.name,
      detail: preset.detail,
      settled,
      settleMs,
      failedState,
      ...summary,
      directions,
      provider: {
        rootTilesetRequests: rootRequests - beforeRoot,
        rendererTileRequests: rendererTiles - beforeTiles,
      },
      consoleProblems: consoleErrors.slice(errorsAt),
      pageShot,
    };
    results.push(record);

    const landed = directions.filter((d) => d.image).length;
    const noWindow = directions.filter((d) => d.leadPhase === "no-window" || d.thumbState === "no window").length;
    console.error(
      `[presets] ${preset.name.padEnd(18)} ` +
        `${settled ? "settled" : "TIMED OUT"} in ${(settleMs / 1000).toFixed(1)}s · ` +
        `${landed}/4 frames · ${noWindow} no-window · ` +
        `${record.provider.rootTilesetRequests} session · ` +
        `${record.consoleProblems.length} console problem(s)`,
    );
  }

  const report = {
    _: "Physical verification of the landing-page presets against the real provider. See verify-presets.mjs.",
    ranAt: new Date().toISOString(),
    url: BASE_URL,
    devicePixelRatio: DPR,
    webglRenderer: renderer,
    billing: {
      rootTilesetRequests: rootRequests,
      note: "Root-tileset requests are the billable unit. 1,000/month free, $6.00/1,000 after.",
      worstCaseUsd: +(rootRequests * 0.006).toFixed(3),
    },
    rendererTileRequests: rendererTiles,
    results,
  };
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.error(`\n[presets] report ${join(OUT, "report.json")}`);
  console.error(
    `[presets] ${rootRequests} billable session(s), worst case $${(rootRequests * 0.006).toFixed(3)}`,
  );
} finally {
  // Cleanup must never be the thing that reports. Chrome keeps writing to its
  // profile for a moment after SIGTERM, so an immediate rm races and throws
  // ENOTEMPTY — from a `finally`, which replaces whatever real failure sent us
  // here with a temp-directory complaint.
  chrome.kill();
  await sleep(500);
  try {
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.error(`[presets] could not remove ${userDataDir}: ${err.code ?? err}`);
  }
}
