#!/usr/bin/env node
// Does an arbitrary typed address render repeatably?
//
// `verify-presets.mjs` clicks the five preset buttons. This one types into the
// real form, which is the case the app actually claims to support, and it does
// it from a COLD browser session with every 27B localStorage key cleared before
// each address — so nothing is answered from a plan or a tileset that an
// earlier case warmed up.
//
// One invocation is one cold session: it launches its own Chrome with its own
// profile and exits. Running the same matrix twice therefore means running this
// twice, which is the point — a result that only reproduces inside one browser
// process has not reproduced.
//
// COST. Photorealistic 3D Tiles bills the root-tileset request, one per render
// session, i.e. one per (address, floor) case here. Free for the first
// 1,000/month, $6.00/1,000 after. The run aborts if it would exceed
// --max-sessions.
//
// Usage (needs a server that has the key — dev reads apps/27b/.env.local):
//
//   node apps/27b/proof/eval-matrix.mjs --url=http://localhost:5177/ --pass=A
//
// Options: --url --pass --out --cases=<comma ids> --max-sessions --timeout --dpr

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

const BASE_URL = arg("url", "http://localhost:5177/");
const PASS = arg("pass", "A");
const OUT = arg("out", join(HERE, "eval-matrix", `pass-${PASS}`));
const ONLY = arg("cases", "").split(",").filter(Boolean);
const MAX_SESSIONS = Number(arg("max-sessions", "14"));
const DPR = Number(arg("dpr", "2"));
const SETTLE_TIMEOUT_MS = Number(arg("timeout", "180000"));

/**
 * The pre-registered matrix. Fixed before any tuning; see
 * .release-artifacts/27b/matrix/PRE-REGISTERED-MATRIX.json for the rationale
 * and the coverage argument. Two floors per address, four directions per floor.
 */
const MATRIX = [
  { id: "432park", address: "432 Park Ave, Manhattan, New York, NY 10022", floors: [80, 30], category: "tall landmark / open north" },
  { id: "esb", address: "350 5th Ave, Manhattan, New York, NY 10118", floors: [80, 20], category: "tall landmark / dense Midtown" },
  { id: "dakota", address: "1 W 72nd St, Manhattan, New York, NY 10023", floors: [7, 3], category: "irregular footprint (courtyard)" },
  { id: "flatiron", address: "175 5th Ave, Manhattan, New York, NY 10010", floors: [18, 6], category: "irregular footprint (triangle)" },
  { id: "425e79", address: "425 E 79th St, Manhattan, New York, NY 10075", floors: [10, 4], category: "dense row building" },
];

mkdirSync(OUT, { recursive: true });

const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9600 + Math.floor(Math.random() * 300);
const userDataDir = await mkdtemp(join(tmpdir(), `27b-matrix-${PASS}-`));

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
  await sleep(1200);

  const gate = JSON.parse(
    await page.eval(`JSON.stringify({
      noSource: Boolean(document.querySelector("[data-state='no-imagery-source']"))
        || /imagery source/i.test(document.body.innerText),
      devHook: typeof window.__27b === "object" && window.__27b !== null,
    })`),
  );
  if (gate.noSource) throw new Error("app is in the no-imagery-source state — run against a keyed server");

  const renderer = await page.eval(`(() => {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    if (!gl) return "no WebGL";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "renderer info unavailable";
  })()`);
  console.error(`[matrix ${PASS}] WebGL renderer: ${renderer}`);
  console.error(`[matrix ${PASS}] dev diagnostic hook: ${gate.devHook ? "present" : "absent (DOM fallback)"}`);

  const cases = MATRIX.filter((c) => ONLY.length === 0 || ONLY.includes(c.id)).flatMap((c) =>
    c.floors.map((floor) => ({ ...c, floor })),
  );

  console.error(
    `[matrix ${PASS}] ${cases.length} case(s), budget ${MAX_SESSIONS} provider session(s)\n`,
  );

  for (const kase of cases) {
    const slug = `${kase.id}-f${kase.floor}`;
    const beforeRoot = rootRequests;
    const beforeTiles = rendererTiles;
    const errorsAt = consoleErrors.length;

    // Cold page, cold cache. Clearing before the reload means the app boots
    // with nothing of its own in storage — a returning visitor's warm plan can
    // never be what makes a case pass here.
    await page.goto(BASE_URL);
    await page.eval(`(() => {
      const kill = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("27b:")) kill.push(k);
      }
      kill.forEach((k) => localStorage.removeItem(k));
      return kill.length;
    })()`);
    await page.goto(BASE_URL);
    await sleep(1000);

    const t0 = Date.now();
    await page.eval(`(() => {
      const set = (el, v) => {
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        desc.set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      set(document.querySelector("#addr"), ${JSON.stringify(kase.address)});
      set(document.querySelector("#floor"), ${JSON.stringify(String(kase.floor))});
      document.querySelector(".form .btn").click();
      return true;
    })()`);

    let settled = false;
    let failedState = null;
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(1000);
      const st = JSON.parse(
        await page.eval(`JSON.stringify((() => {
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
          return { axes };
        })())`),
      );
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
    await sleep(1200);

    // The camera plan as the app itself stored it. Read through the dev-only
    // diagnostic hook when the build exposes one; otherwise fall back to what
    // the page prints, which is coarser but still a real fingerprint.
    const plan = JSON.parse(
      await page.eval(`JSON.stringify((() => {
        if (window.__27b?.plan) {
          const p = window.__27b.plan(${JSON.stringify(kase.address)}, ${kase.floor});
          if (p) return {
            source: "dev-hook",
            algorithm: window.__27b.algorithm ?? null,
            bin: p.footprint.bin,
            basis: p.basis,
            eyeNavd88M: p.eyeElevationNavd88M,
            eyeEllipsoidalM: p.eyeElevationEllipsoidalM,
            clampedToRoof: p.floorClampedToRoof,
            views: p.views.map((v) => ({
              slot: v.slot, compass: v.compass, headingDeg: v.headingDeg,
              lat: v.lat, lng: v.lng, heightM: v.heightM, standoffM: v.standoffM,
            })),
          };
        }
        const metas = [...document.querySelectorAll(".result__meta")].map((m) => m.textContent);
        return {
          source: "dom",
          metas,
          bearings: [...document.querySelectorAll(".thumb")].map((t) =>
            t.querySelector(".thumb__compass")?.textContent ?? null),
        };
      })())`),
    );

    const directions = [];
    const count = Number(await page.eval(`document.querySelectorAll(".thumb").length`));
    for (let i = 0; i < count; i += 1) {
      const disabled = await page.eval(
        `document.querySelectorAll(".thumb")[${i}].disabled === true`,
      );
      if (disabled !== true) {
        await page.eval(`(() => { document.querySelectorAll(".thumb")[${i}].click(); return true; })()`);
        await sleep(1300);
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
            bearing: lead?.querySelector(".lead__bearing")?.textContent ?? null,
            note: lead?.querySelector(".lead__note")?.textContent ?? null,
            image: img ? { w: img.naturalWidth, h: img.naturalHeight } : null,
            rect: r ? { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height } : null,
          };
        })())`),
      );

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
              let edge = 0, m = 0;
              for (let y = 0; y < H; y += 1)
                for (let x = 1; x < W; x += 1) { edge += Math.abs(lum[y*W+x] - lum[y*W+x-1]); m += 1; }
              return {
                meanLuma: +mean.toFixed(1),
                sdLuma: +sd.toFixed(1),
                edgeEnergy: +(edge / m).toFixed(2),
              };
            } catch (err) {
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
      }))())`),
    );

    const record = {
      case: kase.id,
      category: kase.category,
      address: kase.address,
      floor: kase.floor,
      settled,
      settleMs,
      failedState,
      plan,
      ...summary,
      directions,
      provider: {
        rootTilesetRequests: rootRequests - beforeRoot,
        rendererTileRequests: rendererTiles - beforeTiles,
      },
      consoleProblems: consoleErrors.slice(errorsAt),
    };
    results.push(record);

    const landed = directions.filter((d) => d.image).length;
    const noWindow = directions.filter((d) => d.leadPhase === "no-window").length;
    console.error(
      `[matrix ${PASS}] ${slug.padEnd(16)} ${settled ? "settled" : "TIMED OUT"} ` +
        `in ${(settleMs / 1000).toFixed(1)}s · ${landed}/${directions.length} frames · ` +
        `${noWindow} no-window · ${record.provider.rootTilesetRequests} session · ` +
        `${record.consoleProblems.length} console problem(s)`,
    );
  }

  const report = {
    _: "Pre-registered evaluation matrix, typed addresses, one cold browser session per invocation. See eval-matrix.mjs.",
    pass: PASS,
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
  console.error(`\n[matrix ${PASS}] report ${join(OUT, "report.json")}`);
  console.error(
    `[matrix ${PASS}] ${rootRequests} billable session(s), worst case $${(rootRequests * 0.006).toFixed(3)}`,
  );
} finally {
  chrome.kill();
  await sleep(500);
  try {
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.error(`[matrix ${PASS}] could not remove ${userDataDir}: ${err.code ?? err}`);
  }
}
