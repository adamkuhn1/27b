#!/usr/bin/env node
// Layout screenshots for 27B.
//
// COSTS NOTHING. This drives the app with NO imagery key configured, so the
// renderer is unreachable by construction (see lib/config.ts) and no provider
// request is possible. What it captures is the page structure — the masthead,
// the lead view, the direction strip, the plan drawing, the empty-frame states
// — which is exactly what the presentation work changed. Frames are empty here
// because there is no key, not because anything failed.
//
// Uses the repo's own zero-dependency CDP client rather than adding Playwright,
// same as proof/bakeoff/run.mjs. Its own Chrome, so a browser being driven by
// something else cannot steal focus mid-capture.
//
// Usage, with a dev server already running:
//   node apps/27b/proof/shoot.mjs --url=http://localhost:5199/ --out=<dir> --tag=after

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
  argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ??
  fallback;

const BASE_URL = arg("url", "http://localhost:5199/");
const OUT = arg("out", join(HERE, "screenshots"));
const TAG = arg("tag", "shot");
const DPR = Number(arg("dpr", "2"));

mkdirSync(OUT, { recursive: true });

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9400 + Math.floor(Math.random() * 500);
const userDataDir = await mkdtemp(join(tmpdir(), "27b-shots-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
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

const shots = [];
try {
  await waitForChrome();
  const page = await attachToPage(port);

  // Fail loudly if a key IS configured: this script must never be the thing
  // that spends money, and a silent billable run would be the worst outcome.
  await page.send("Network.enable");
  page.on("Network.requestWillBeSent", ({ request }) => {
    if (request.url.includes("tile.googleapis.com")) {
      throw new Error("provider request attempted — shoot.mjs must run keyless");
    }
  });

  await page.goto(BASE_URL);
  await sleep(1200);

  async function shot(name) {
    const { data } = await page.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });
    const file = join(OUT, `${TAG}-${name}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    shots.push(file);
    console.error(`[shoot] ${file}`);
  }

  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: DPR,
    mobile: false,
  });
  await sleep(400);
  await shot("01-landing");

  // 425 E 79th at floor 10: the building with both a party wall and a light
  // court, i.e. the case the enclosure work is about.
  //
  // Driven through the form rather than a preset button so the same script can
  // shoot an older revision of the app for comparison, where the presets are a
  // different set of buildings.
  await page.eval(`(() => {
    const set = (el, v) => {
      const proto = Object.getPrototypeOf(el);
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const inputs = [...document.querySelectorAll("input")];
    const address = inputs.find((el) => el.type !== "number");
    const floor = inputs.find((el) => el.type === "number");
    if (!address || !floor) throw new Error("address form not found");
    set(address, "425 E 79th St, Manhattan, New York, NY 10075");
    set(floor, "10");
    document.querySelector("form").requestSubmit();
    return true;
  })()`);
  await sleep(5000);
  await shot("02-result-425e79-floor10");

  // The light-court direction, promoted, so its close-range labelling shows.
  await page.eval(`(() => {
    const b = [...document.querySelectorAll(".thumb")]
      .find((el) => el.textContent.includes("close range"));
    if (b) b.click();
    return Boolean(b);
  })()`);
  await sleep(600);
  await shot("03-close-range-direction");

  // The measured widths behind the layout claims, read off the live DOM rather
  // than asserted from the stylesheet.
  const measured = await page.eval(`JSON.stringify((() => {
    const q = (s) => document.querySelector(s);
    const w = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null);
    return {
      devicePixelRatio: window.devicePixelRatio,
      contentColumnCss: w(q(".app__inner")),
      leadFrameCss: w(q(".lead .view__canvas") || q(".lead img")),
      thumbFrameCss: w(q(".thumb__frame")),
      planCss: w(q(".plan")),
    };
  })())`);
  writeFileSync(join(OUT, `${TAG}-measurements.json`), measured);
  console.error(`[shoot] measurements ${measured}`);
} finally {
  chrome.kill();
  await rm(userDataDir, { recursive: true, force: true });
}

console.error(`[shoot] ${shots.length} screenshots written to ${OUT}`);
