#!/usr/bin/env node
// Runner for the 27B rendering bake-off.
//
// Drives the real app modules through the real Vite dev server in a real
// Chrome with a real GPU, using the repo's own zero-dependency CDP client
// (apps/portfolio/qa/cdp.mjs). Playwright is not a dependency of this repo.
//
// COST. Each `render` case opens exactly one Cesium session and therefore costs
// exactly one Photorealistic 3D Tiles root-tileset request — the billable unit
// (SKU C6E1-98B2-DBD0: 1,000 free/month, then $6.00/1,000, i.e. $0.006 each).
// Renderer tile requests inside an open session are unmetered. The runner
// counts both from the network layer and refuses to start a plan whose
// worst-case cost exceeds --budget.
//
// Usage, from the repo root, with the dev server already running on 5174:
//   node apps/27b/proof/bakeoff/run.mjs <plan.json> [--budget 0.30] [--dry]

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { attachToPage, sleep } from "../../../portfolio/qa/cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const BASE_URL = process.env.BAKEOFF_URL ?? "http://localhost:5174/";
const USD_PER_ROOT_REQUEST = 0.006;

const argv = process.argv.slice(2);
const planPath = argv.find((a) => !a.startsWith("--"));
const budget = Number(argv.find((a) => a.startsWith("--budget="))?.split("=")[1] ?? 0.3);
const dry = argv.includes("--dry");
if (!planPath) {
  console.error("usage: run.mjs <plan.json> [--budget=0.30] [--dry]");
  process.exit(2);
}

const plan = JSON.parse(readFileSync(resolve(planPath), "utf8"));
const renderCases = plan.cases.filter((c) => c.kind === "render");
const worstCase = renderCases.length * USD_PER_ROOT_REQUEST;
console.error(
  `[bakeoff] ${plan.id}: ${plan.cases.length} cases (${renderCases.length} billable) ` +
    `-> worst case $${worstCase.toFixed(3)} of $${budget.toFixed(2)}`,
);
if (worstCase > budget) {
  console.error("[bakeoff] STOP: projected spend exceeds the declared budget.");
  process.exit(3);
}
if (dry) process.exit(0);

mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, "frames"), { recursive: true });

// ---------------------------------------------------------------------------
// Chrome. Launched here rather than via cdp.mjs's `launchChrome` for one
// reason: this capture must run on the real GPU, and that needs flags the
// screenshot harness has no use for. Everything after the handshake is the
// repo's own client.
// ---------------------------------------------------------------------------
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9400 + Math.floor(Math.random() * 500);
const userDataDir = await mkdtemp(join(tmpdir(), "27b-bakeoff-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    // Real GPU. Headless Chrome falls back to SwiftShader without these, and a
    // software rasteriser would make every quality comparison below meaningless.
    "--use-angle=metal",
    "--enable-gpu",
    "--force-device-scale-factor=1",
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
const chromeVersion = await waitForChrome();
const page = await attachToPage(port);

// ---------------------------------------------------------------------------
// Network accounting. Query strings are stripped before anything is recorded so
// the API key can never reach a log, a JSON file or a console line.
// ---------------------------------------------------------------------------
let net = newCounters();
function newCounters() {
  return { rootTileset: 0, rendererTiles: 0, otherTileHost: 0, bytes: 0 };
}
await page.send("Network.enable");
page.on("Network.requestWillBeSent", ({ request }) => {
  const url = request.url;
  if (!url.includes("tile.googleapis.com")) return;
  const path = url.split("?")[0];
  if (path.includes("/3dtiles/root.json")) net.rootTileset += 1;
  else if (path.includes("/3dtiles/")) net.rendererTiles += 1;
  else net.otherTileHost += 1;
});
page.on("Network.loadingFinished", ({ encodedDataLength }) => {
  net.bytes += encodedDataLength ?? 0;
});

const consoleErrors = [];
await page.send("Runtime.enable");
page.on("Runtime.consoleAPICalled", (e) => {
  if (e.type !== "error") return;
  const text = e.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 240);
  consoleErrors.push(text);
});

await page.goto(BASE_URL);
await page.eval(
  `import("/proof/bakeoff/driver.js").then((m) => { window.__drv = m; return "loaded"; })`,
);
const gpu = await page.eval(`window.__drv.gpuInfo()`);
const cesiumDefaults = await page.eval(`window.__drv.cesiumDefaults()`);
console.error(`[bakeoff] Cesium ${cesiumDefaults.cesiumVersion} defaults: ${JSON.stringify(cesiumDefaults.frustum)} ${JSON.stringify(cesiumDefaults.viewer)} ${JSON.stringify(cesiumDefaults.scene)} canvas=${JSON.stringify(cesiumDefaults.canvas)} dpr=${cesiumDefaults.devicePixelRatio}`);
console.error(`[bakeoff] GPU: ${gpu.renderer} (${gpu.vendor})`);
if (/swiftshader|llvmpipe|software/i.test(String(gpu.renderer))) {
  console.error("[bakeoff] STOP: software rasteriser — results would be meaningless.");
  chrome.kill("SIGTERM");
  process.exit(4);
}

const MAX_RENDERER_TILES = 9000;
const MAX_CASE_MS = 120_000;

/** Trips when a case exceeds a declared hard stop. Resolves; never rejects. */
function watchdog(c) {
  let stop = () => {};
  const started = Date.now();
  const tripped = new Promise((resolve) => {
    const t = setInterval(() => {
      const overTiles = net.rendererTiles > MAX_RENDERER_TILES;
      const overTime = Date.now() - started > MAX_CASE_MS * ((c.slots?.length ?? 4) / 2);
      if (overTiles || overTime) {
        clearInterval(t);
        resolve({
          ok: false,
          abortedByGuard: true,
          reason: overTiles ? "renderer-tile-ceiling" : "wall-clock-ceiling",
          rendererTiles: net.rendererTiles,
          elapsedMs: Date.now() - started,
        });
      }
    }, 1000);
    stop = () => clearInterval(t);
  });
  return { tripped, stop: () => stop() };
}

const results = [];
let billable = 0;

for (const [i, c] of plan.cases.entries()) {
  const label = `${i + 1}/${plan.cases.length} ${c.id}`;
  net = newCounters();
  const before = consoleErrors.length;
  const t0 = Date.now();

  try {
    if (c.kind === "geometry") {
      process.stderr.write(`[bakeoff] ${label} (geometry, free)\n`);
      const r = await page.eval(
        `window.__drv.geometryProbe(${JSON.stringify({
          address: c.address,
          floor: c.floor,
          offsets: c.offsets,
        })})`,
      );
      results.push({ ...c, wallMs: Date.now() - t0, net, result: r });
    } else {
      if ((billable + 1) * USD_PER_ROOT_REQUEST > budget) {
        console.error("[bakeoff] STOP: budget reached mid-plan.");
        break;
      }
      process.stderr.write(`[bakeoff] ${label} (render, billable)\n`);
      // Declared hard stops (MATRIX.md): a case may not exceed
      // MAX_RENDERER_TILES requests or MAX_CASE_MS of wall clock. Both are
      // enforced by tearing the page down, which destroys the WebGL context and
      // with it the Cesium session — the only reliable way to stop a runaway
      // refinement from the outside.
      const guard = watchdog(c);
      let r;
      try {
        r = await Promise.race([
          page.eval(
            `window.__drv.renderConfig(${JSON.stringify({
              address: c.address,
              floor: c.floor,
              offsetM: c.offsetM,
              slots: c.slots ?? null,
              render: c.render ?? {},
            })})`,
          ),
          guard.tripped,
        ]);
      } finally {
        guard.stop();
      }
      billable += 1;
      if (r?.abortedByGuard) {
        await page.goto(BASE_URL);
        await page.eval(
          `import("/proof/bakeoff/driver.js").then((m) => { window.__drv = m; return "reloaded"; })`,
        );
      }

      if (r.ok) {
        for (let f = 0; f < r.frames.length; f++) {
          const dataUrl = await page.eval(`window.__drv.takeFrame(${f})`);
          if (!dataUrl) continue;
          const file = join(OUT, "frames", `${c.id}--${r.frames[f].slot}.png`);
          writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
          r.frames[f].file = file.slice(file.indexOf("apps/27b"));
        }
        await page.eval(`window.__bakeFrames = null; "cleared"`);
      }
      results.push({
        ...c,
        wallMs: Date.now() - t0,
        net,
        consoleErrors: consoleErrors.slice(before, before + 6),
        result: r,
      });
    }
  } catch (err) {
    console.error(`[bakeoff] ${label} FAILED: ${String(err).slice(0, 300)}`);
    results.push({ ...c, wallMs: Date.now() - t0, net, error: String(err).slice(0, 500) });
  }

  const r = results[results.length - 1];
  console.error(
    `[bakeoff]   ${((r.wallMs ?? 0) / 1000).toFixed(1)}s  root=${r.net.rootTileset} ` +
      `tiles=${r.net.rendererTiles}  MB=${(r.net.bytes / 1048576).toFixed(1)}` +
      (r.result?.surface ? `  canvas=${r.result.surface.canvasWidth}x${r.result.surface.canvasHeight}` : ""),
  );
  // Let the GPU settle between sessions so one run's teardown cannot pollute
  // the next run's timing.
  await sleep(1500);
}

const summary = {
  planId: plan.id,
  note: plan.note,
  generatedAt: new Date().toISOString(),
  chrome: chromeVersion.Browser,
  gpu,
  cesiumDefaults,
  billableSessions: billable,
  estimatedUsd: +(billable * USD_PER_ROOT_REQUEST).toFixed(3),
  results,
};
const summaryFile = join(OUT, `${plan.id}.json`);
writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
console.error(
  `\n[bakeoff] done: ${billable} billable sessions, $${summary.estimatedUsd} worst case\n` +
    `[bakeoff] ${summaryFile}`,
);

page.close();
chrome.kill("SIGTERM");
await sleep(400);
await rm(userDataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
