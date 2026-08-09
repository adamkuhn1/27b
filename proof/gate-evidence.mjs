#!/usr/bin/env node
// The three product-level claims the eval matrix cannot answer on its own:
// that an unresolvable address is refused rather than quietly answered with a
// different building, that a returning session reuses a stored plan only while
// the algorithm fingerprint matches, and that a changed fingerprint recomputes.
//
// COST: nothing. Every navigation here runs with `*tile.googleapis.com*` blocked
// at the network layer, because none of these claims is about imagery — they are
// about the geometry pipeline, which is GeoSearch + NYC Open Data + our own
// math. Blocking the provider means the root-tileset request is never sent, so
// the run is free and can be repeated as often as it needs to be.
//
// Usage (needs a server that has the key — dev reads apps/27b/.env.local):
//
//   node apps/27b/proof/gate-evidence.mjs --url=http://localhost:5177/
//
// Options: --url --out

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { attachToPage, sleep } from "../../portfolio/qa/cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=") ?? d;

const BASE_URL = arg("url", "http://localhost:5177/");
const OUT = arg("out", join(HERE, "gate-evidence"));

/** Redact the key before anything is written to disk or printed. */
const scrub = (s) => String(s).replace(/([?&]key=)[^&]+/gi, "$1<redacted>");

/**
 * Addresses that must be refused.
 *
 * The first is the pre-registered `invalid` case. The second is an extension
 * added for this run and named as such in the report: a house number that does
 * not exist on a street that does. It separates "the geocoder found nothing"
 * from "the geocoder found the nearest thing it could" — only the second can
 * substitute a building, and only an address of this shape provokes it.
 */
const REFUSALS = [
  { id: "invalid", address: "9999 5th Ave, Manhattan, New York, NY 10028", preRegistered: true },
  { id: "wrong-number", address: "848 W 72nd St, Manhattan, New York, NY 10023", preRegistered: false },
];

/** The address the cache proof uses. Dense row building, four real facades. */
const CACHE_CASE = { address: "425 E 79th St, Manhattan, New York, NY 10075", floor: 10 };

mkdirSync(OUT, { recursive: true });

const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9300 + Math.floor(Math.random() * 90);
const userDataDir = await mkdtemp(join(tmpdir(), "27b-gate-"));

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

const report = {
  _: "Product-level claims that the frame matrix cannot answer: no address substitution, and cache reuse gated on the algorithm fingerprint. Provider imagery is blocked throughout, so this run is free.",
  ranAt: new Date().toISOString(),
  url: BASE_URL,
  providerBlocked: "*tile.googleapis.com*",
};

try {
  await waitForChrome();
  const page = await attachToPage(port);
  await page.send("Network.enable");
  await page.send("Runtime.enable");
  await page.send("Log.enable");
  await page.send("Network.setBlockedURLs", { urls: ["*tile.googleapis.com*"] });
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const requests = [];
  page.on("Network.requestWillBeSent", ({ request }) => requests.push(scrub(request.url)));
  const consoleProblems = [];
  page.on("Runtime.consoleAPICalled", (e) => {
    if (e.type !== "error" && e.type !== "warning") return;
    consoleProblems.push({
      level: e.type,
      text: scrub(e.args.map((a) => a.value ?? a.description ?? a.type).join(" ")),
    });
  });

  /** Reload cold, clearing every 27B key, unless `keepStorage` says otherwise. */
  async function coldLoad({ keepStorage = false } = {}) {
    await page.goto(BASE_URL);
    if (!keepStorage) {
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
    }
    await sleep(900);
  }

  async function search(address, floor) {
    await page.eval(`(() => {
      const set = (el, v) => {
        const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
        d.set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      set(document.querySelector("#addr"), ${JSON.stringify(address)});
      set(document.querySelector("#floor"), ${JSON.stringify(String(floor))});
      document.querySelector(".form .btn").click();
      return true;
    })()`);
  }

  /** Whatever the page is showing once it stops working: a refusal or a result. */
  async function readOutcome(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      await sleep(700);
      last = JSON.parse(
        await page.eval(`JSON.stringify((() => {
          const bad = document.querySelector(".state");
          const metas = [...document.querySelectorAll(".result__meta")].map((m) =>
            (m.textContent || "").replace(/\\s+/g, " ").trim());
          return {
            refusalTitle: bad?.querySelector(".state__title")?.textContent ?? null,
            refusalBody: bad?.querySelector(".state__body")?.textContent ?? null,
            resolvedAddress: document.querySelector(".result__addr")?.textContent ?? null,
            frameLine: document.querySelector(".result__frame")?.textContent ?? null,
            metas,
            planAriaLabel: document.querySelector(".plan__svg")?.getAttribute("aria-label") ?? null,
            thumbs: [...document.querySelectorAll(".thumb")].length,
            cacheKeys: (() => {
              const out = [];
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith("27b:cache:")) out.push(k);
              }
              return out.sort();
            })(),
          };
        })())`),
      );
      if (last.refusalTitle || last.metas.length > 0) break;
    }
    return last;
  }

  /** GeoSearch / NYC Open Data calls are the tell that a plan was recomputed. */
  const isPipelineCall = (u) =>
    u.includes("geosearch.planninglabs.nyc") || u.includes("data.cityofnewyork.us");

  // ---------------------------------------------------------------------
  // 1. An address that cannot be resolved is refused, and nothing else is
  //    rendered in its place.
  // ---------------------------------------------------------------------
  report.noSubstitution = [];
  for (const kase of REFUSALS) {
    await coldLoad();
    const from = requests.length;
    await search(kase.address, 10);
    const outcome = await readOutcome();
    const during = requests.slice(from);
    report.noSubstitution.push({
      ...kase,
      typed: kase.address,
      outcome,
      renderedAnyBuilding: Boolean(outcome.resolvedAddress || outcome.metas.length),
      tileRequests: during.filter((u) => u.includes("tile.googleapis.com")).length,
      pipelineRequests: during.filter(isPipelineCall).length,
      cacheKeysAfter: outcome.cacheKeys,
    });
    console.error(
      `[gate] refusal ${kase.id.padEnd(13)} "${outcome.refusalTitle ?? "NO REFUSAL"}" · ` +
        `rendered=${Boolean(outcome.resolvedAddress)} · tiles=${
          during.filter((u) => u.includes("tile.googleapis.com")).length
        }`,
    );
  }

  // ---------------------------------------------------------------------
  // 2. Cache fingerprint. Three searches of the same (address, floor):
  //    cold, returning, and returning with the stored entry moved under a
  //    different algorithm version — which is what a changed constant does to
  //    the key.
  // ---------------------------------------------------------------------
  const steps = [];

  await coldLoad();
  let from = requests.length;
  await search(CACHE_CASE.address, CACHE_CASE.floor);
  const cold = await readOutcome();
  steps.push({
    step: "cold",
    note: "no 27B key in storage; the plan has to be computed",
    pipelineRequests: requests.slice(from).filter(isPipelineCall).length,
    metas: cold.metas,
    planAriaLabel: cold.planAriaLabel,
    cacheKeys: cold.cacheKeys,
  });

  await coldLoad({ keepStorage: true });
  from = requests.length;
  await search(CACHE_CASE.address, CACHE_CASE.floor);
  const warm = await readOutcome();
  steps.push({
    step: "returning, fingerprint matches",
    note: "the stored entry's version equals this build's, so it is served",
    pipelineRequests: requests.slice(from).filter(isPipelineCall).length,
    metas: warm.metas,
    planAriaLabel: warm.planAriaLabel,
    cacheKeys: warm.cacheKeys,
  });

  // Move the stored plan under a different algorithm version, byte for byte
  // otherwise. This is exactly the state a visitor's browser is in after a
  // constant moves: same plan, same address, a fingerprint that no longer
  // matches the code.
  const moved = JSON.parse(
    await page.eval(`JSON.stringify((() => {
      let key = null;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("27b:cache:")) { key = k; break; }
      }
      if (!key) return { moved: false };
      const raw = localStorage.getItem(key);
      const env = JSON.parse(raw);
      const stale = key.replace(/27b:cache:v\\d+-[0-9a-f]{8}:/, "27b:cache:v5-deadbeef:");
      localStorage.removeItem(key);
      localStorage.setItem(stale, JSON.stringify({ ...env, v: "v5-deadbeef" }));
      return { moved: true, from: key, to: stale, planUnchanged: JSON.stringify(env.plan) === JSON.stringify(JSON.parse(localStorage.getItem(stale)).plan) };
    })())`),
  );

  await coldLoad({ keepStorage: true });
  from = requests.length;
  await search(CACHE_CASE.address, CACHE_CASE.floor);
  const stale = await readOutcome();
  steps.push({
    step: "returning, fingerprint changed",
    note: "the same plan under a version this build does not recognise",
    rekey: moved,
    pipelineRequests: requests.slice(from).filter(isPipelineCall).length,
    metas: stale.metas,
    planAriaLabel: stale.planAriaLabel,
    cacheKeys: stale.cacheKeys,
  });

  report.cacheFingerprint = {
    case: CACHE_CASE,
    steps,
    reusedWhenFingerprintMatches:
      steps[1].pipelineRequests === 0 && steps[1].planAriaLabel === steps[0].planAriaLabel,
    recomputedWhenFingerprintChanged:
      steps[2].pipelineRequests > 0 &&
      !steps[2].cacheKeys.some((k) => k.includes("deadbeef")) &&
      steps[2].planAriaLabel === steps[0].planAriaLabel,
  };

  for (const s of steps) {
    console.error(
      `[gate] cache ${s.step.padEnd(34)} pipeline calls ${s.pipelineRequests} · keys ${s.cacheKeys.length}`,
    );
  }

  report.consoleProblems = consoleProblems;
  report.providerRequestsSeen = requests.filter((u) => u.includes("tile.googleapis.com")).length;
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.error(`\n[gate] report ${join(OUT, "report.json")}`);
  console.error(`[gate] provider requests attempted: ${report.providerRequestsSeen} (all blocked, none billable)`);
} finally {
  chrome.kill();
  await sleep(400);
  await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
