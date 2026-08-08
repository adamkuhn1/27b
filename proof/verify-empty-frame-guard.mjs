#!/usr/bin/env node
// Does the zero-triangle guard actually stop a sky-only frame reaching the page?
//
// `tileRenderer.ts` refuses to present a capture in which no provider triangle
// drew. The condition it guards — a settle that times out having loaded nothing
// — is rare and cannot be summoned by waiting for it, so the guard has never
// been seen to fire in a live run. This reproduces it deterministically:
// Chrome is told to block the renderer's tile requests while leaving the root
// tileset request alone, so the session opens normally and then starves.
//
// PASS means the four directions end in the app's honest failure state and no
// frame is presented. FAIL means an empty picture reached the page under the
// visitor's address, which is the fabricated-scene failure arriving by
// accident.
//
// COST. One root-tileset request — the billable unit — because the session does
// open. $0.006 at full price, free inside the 1,000/month cap.
//
// Usage: node apps/27b/proof/verify-empty-frame-guard.mjs --url=http://localhost:5178/

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { attachToPage, sleep } from "../../portfolio/qa/cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) =>
  argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=") ?? d;

const BASE_URL = arg("url", "http://localhost:5178/");
const ADDRESS = arg("address", "1 W 72nd St, Manhattan, New York, NY 10023");
const FLOOR = Number(arg("floor", "7"));
const OUT = arg("out", join(HERE, "empty-frame-guard"));
const TIMEOUT_MS = Number(arg("timeout", "240000"));

mkdirSync(OUT, { recursive: true });

const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9400 + Math.floor(Math.random() * 150);
const userDataDir = await mkdtemp(join(tmpdir(), "27b-emptyguard-"));

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
    "--force-device-scale-factor=1",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const scrub = (s) => String(s).replace(/([?&]key=)[^&]+/gi, "$1<redacted>");

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

let rootRequests = 0;
let blockedTileRequests = 0;

try {
  await waitForChrome();
  const page = await attachToPage(port);
  await page.send("Network.enable");
  await page.send("Runtime.enable");

  const consoleLines = [];
  page.on("Runtime.consoleAPICalled", (e) => {
    const text = e.args.map((a) => a.value ?? a.description ?? a.type).join(" ");
    consoleLines.push({ level: e.type, text: scrub(text) });
  });
  page.on("Network.requestWillBeSent", ({ request }) => {
    if (!request.url.includes("tile.googleapis.com")) return;
    if (request.url.includes("/3dtiles/root.json")) rootRequests += 1;
    else blockedTileRequests += 1;
  });

  // Everything under /3dtiles/ except the root tileset document. The session
  // therefore opens — and is billed — exactly as it would normally, and then
  // has no geometry to draw.
  await page.send("Network.setBlockedURLs", {
    urls: ["*tile.googleapis.com/v1/3dtiles/datasets/*"],
  });

  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await page.goto(BASE_URL);
  await sleep(1000);
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

  await page.eval(`(() => {
    const set = (el, v) => {
      const proto = Object.getPrototypeOf(el);
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set(document.querySelector("#addr"), ${JSON.stringify(ADDRESS)});
    set(document.querySelector("#floor"), ${JSON.stringify(String(FLOOR))});
    document.querySelector(".form .btn").click();
    return true;
  })()`);

  // Wait until every direction has reached a terminal state.
  const deadline = Date.now() + TIMEOUT_MS;
  let state = null;
  while (Date.now() < deadline) {
    await sleep(2000);
    state = JSON.parse(
      await page.eval(`JSON.stringify((() => {
        const axes = [...document.querySelectorAll(".plan__axis")].map((g) =>
          (g.className.baseVal || "").replace(/.*plan__axis--/, ""));
        const lead = document.querySelector(".lead");
        return {
          axes,
          leadPhase: lead?.getAttribute("data-phase") ?? null,
          leadHasImage: Boolean(lead?.querySelector("img")),
          leadNote: lead?.querySelector(".lead__note")?.textContent ?? null,
          bad: document.querySelector(".state__title")?.textContent ?? null,
        };
      })())`),
    );
    const working = state.axes.filter((a) => a === "queued" || a === "capturing").length;
    if (state.axes.length >= 4 && working === 0) break;
  }

  // Every direction, not just the one shown large.
  const perDirection = [];
  const count = Number(await page.eval(`document.querySelectorAll(".thumb").length`));
  for (let i = 0; i < count; i += 1) {
    const disabled = await page.eval(`document.querySelectorAll(".thumb")[${i}].disabled === true`);
    if (disabled !== true) {
      await page.eval(`(() => { document.querySelectorAll(".thumb")[${i}].click(); return true; })()`);
      await sleep(800);
    }
    perDirection.push(
      JSON.parse(
        await page.eval(`JSON.stringify((() => {
          const lead = document.querySelector(".lead");
          return {
            compass: document.querySelectorAll(".thumb")[${i}]?.querySelector(".thumb__compass")?.textContent ?? null,
            leadPhase: lead?.getAttribute("data-phase") ?? null,
            hasImage: Boolean(lead?.querySelector("img")),
            note: lead?.querySelector(".lead__note")?.textContent ?? null,
          };
        })())`),
      ),
    );
  }

  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  const shot = join(OUT, "starved-session.png");
  writeFileSync(shot, Buffer.from(data, "base64"));

  const emptyFrameLogs = consoleLines.filter((l) => /0 triangles|sky only/i.test(l.text));
  const presentedFrames = perDirection.filter((d) => d.hasImage).length;
  const pass = presentedFrames === 0 && emptyFrameLogs.length > 0;

  const report = {
    _: "Renderer tile requests blocked at the network layer so the session opens and then starves. PASS = the zero-triangle guard refused every frame and the app said so.",
    ranAt: new Date().toISOString(),
    url: BASE_URL,
    address: ADDRESS,
    floor: FLOOR,
    pass,
    presentedFrames,
    finalState: state,
    perDirection,
    emptyFrameLogs,
    consoleLines,
    shot,
    billing: {
      rootTilesetRequests: rootRequests,
      blockedRendererTileRequests: blockedTileRequests,
      worstCaseUsd: +(rootRequests * 0.006).toFixed(3),
    },
  };
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");

  console.error(`[guard] presented frames: ${presentedFrames} (expect 0)`);
  console.error(`[guard] empty-frame log lines: ${emptyFrameLogs.length} (expect > 0)`);
  console.error(`[guard] ${pass ? "PASS" : "FAIL"} — ${join(OUT, "report.json")}`);
  console.error(`[guard] ${rootRequests} billable session(s), worst case $${(rootRequests * 0.006).toFixed(3)}`);
  if (!pass) process.exitCode = 1;
} finally {
  chrome.kill();
  await sleep(500);
  await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
    () => {},
  );
}
