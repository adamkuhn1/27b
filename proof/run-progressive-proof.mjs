#!/usr/bin/env node
// Browser proof for the progressive render path — against a STUBBED renderer.
//
// COST: $0.00, structurally. The real renderer module is never loaded: every
// request for the `tileRenderer` chunk is intercepted and fulfilled with a stub
// that implements the same `openRenderSession` contract with no Cesium and no
// network. So no root tileset request can be made even by accident, whatever
// key the build carries. The only endpoints this harness lets through are the
// free, keyless NYC ones the geometry pipeline uses, and every request the page
// makes is recorded so that claim is checkable rather than asserted.
//
// The stub emits 1x1 TRANSPARENT PNGs. It does not draw a scene, a gradient, a
// silhouette or anything else that could be mistaken for imagery — the thing
// being proven is the sequence of per-direction state transitions, which is
// read from the DOM, not from pixels. There is no point in this harness at
// which a fabricated view appears on screen.
//
// What it records:
//   1. landing        — every request made before any user action, and whether
//                       the renderer chunk was fetched at all
//   2. progressive    — the per-slot phase timeline as four directions land
//   3. partial        — one direction fails permanently; the other three stay
//   4. session-failed — the session never opens; nothing is drawn
//   5. mobile         — the same at 390x844
//
// Usage:
//   VITE_GOOGLE_MAPS_KEY=<placeholder> npm run build -w @portfolio-suite/27b
//   npx vite preview --port 5175 --strictPort   (from apps/27b)
//   mkdir -p /tmp/pw && (cd /tmp/pw && npm i playwright)
//   NODE_PATH=/tmp/pw/node_modules node apps/27b/proof/run-progressive-proof.mjs

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(
  HERE,
  "..",
  "..",
  "..",
  "docs",
  "repair",
  "personal-authorship-sprint",
  "evidence",
);
const URL_BASE = process.env.PROOF_URL ?? "http://localhost:5175/";
const ADDRESS = "350 5th Ave, Manhattan, New York, NY 10118";
const FLOOR = "80";

/** Anything that would cost money, or that belongs to the imagery provider. */
const PROVIDER_HOSTS = [
  "googleapis.com",
  "google.com",
  "gstatic.com",
  "cesium.com",
  "ion.cesium.com",
];

const isProvider = (url) => PROVIDER_HOSTS.some((h) => new URL(url).hostname.endsWith(h));

/**
 * The stub module served in place of the real tileRenderer chunk.
 *
 * `script` maps a slot to "ok" | "fail", and `openFails` makes the session
 * itself refuse to open. `delayMs` spaces the captures out so the reveal is
 * observable rather than instantaneous.
 */
function stubModule({ script = {}, openFails = false, delayMs = 400 }) {
  return `
const TRANSPARENT_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const SCRIPT = ${JSON.stringify(script)};
const OPEN_FAILS = ${JSON.stringify(openFails)};
const DELAY = ${JSON.stringify(delayMs)};

class Channel {
  constructor() { this.buf = []; this.waiters = []; this.ended = false; }
  push(v) {
    if (this.ended) return;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false }); else this.buf.push(v);
  }
  end() {
    if (this.ended) return;
    this.ended = true;
    for (const w of this.waiters) w({ value: undefined, done: true });
    this.waiters = [];
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.buf.length) return Promise.resolve({ value: this.buf.shift(), done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

export async function openRenderSession(views, opts) {
  if (OPEN_FAILS) throw new Error("stub: session refused to open (403 Forbidden)");
  const ch = new Channel();
  let open = true;
  const close = () => { if (!open) return; open = false; ch.push({ kind: "session-closed", reason: "complete" }); ch.end(); };
  opts?.signal?.addEventListener("abort", () => {
    if (!open) return; open = false;
    ch.push({ kind: "session-closed", reason: "aborted" }); ch.end();
  }, { once: true });

  (async () => {
    ch.push({ kind: "session-open", rootRequests: 1 });
    for (const v of views) {
      if (!open) return;
      ch.push({ kind: "view-started", slot: v.slot, attempt: 1 });
      await new Promise((r) => setTimeout(r, DELAY));
      if (!open) return;
      if (SCRIPT[v.slot] === "fail") {
        ch.push({
          kind: "view-failed",
          slot: v.slot,
          failure: { kind: "capture-failed", detail: "stub: synthetic failure", fatalForSession: false },
          attempt: 1,
          willRetry: false,
        });
      } else {
        ch.push({
          kind: "view-captured",
          result: { slot: v.slot, dataUrl: TRANSPARENT_1PX, attribution: ["Google", "Stub Imaging"] },
          settled: true,
          elapsedMs: DELAY,
          attempt: 1,
        });
      }
    }
    close();
  })();

  return {
    events: ch,
    get isOpen() { return open; },
    recapture: async () => ({ kind: "view-failed", slot: "V1", failure: { kind: "capture-failed", detail: "stub", fatalForSession: false }, attempt: 2, willRetry: false }),
    close,
  };
}
`;
}

async function newRun(browser, { viewport, stub } = {}) {
  const context = await browser.newContext(
    viewport ? { viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {},
  );
  const page = await context.newPage();
  const requests = [];
  page.on("request", (r) => requests.push({ url: r.url(), method: r.method() }));

  if (stub) {
    await page.route("**/assets/tileRenderer-*.js", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/javascript; charset=utf-8",
        body: stubModule(stub),
      }),
    );
  }
  return { context, page, requests };
}

const providerRequests = (requests) => requests.filter((r) => isProvider(r.url));

/** Read the four panes' phases and whether each contains an <img>. */
async function readSlots(page) {
  return page.$$eval(".view", (figs) =>
    figs.map((f) => ({
      label: f.querySelector(".view__compass")?.textContent ?? null,
      bearing: f.querySelector(".view__bearing")?.textContent ?? null,
      phase: f.getAttribute("data-phase"),
      hasImg: !!f.querySelector("img"),
      note: f.querySelector(".view__note")?.textContent ?? null,
    })),
  );
}

async function submit(page) {
  await page.fill("#addr", ADDRESS);
  await page.fill("#floor", FLOOR);
  await page.click("form.form button[type=submit]");
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const evidence = {
    artifact: "27B progressive render + anti-fabrication, real browser",
    measuredAt: new Date().toISOString().slice(0, 10),
    cost: "$0.00 — the renderer chunk is intercepted and replaced with a stub, so no root tileset request is possible. Only free, keyless NYC endpoints are reached.",
    url: URL_BASE,
    harness: "apps/27b/proof/run-progressive-proof.mjs",
    cases: {},
  };

  // ---------------------------------------------------------------- 1. landing
  {
    const { context, page, requests } = await newRun(browser);
    await page.goto(URL_BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    evidence.cases.landing = {
      what: "Page loaded. No address submitted, nothing clicked.",
      requestCount: requests.length,
      providerRequests: providerRequests(requests).map((r) => r.url),
      rendererChunkFetched: requests.some((r) => /tileRenderer-.*\.js/.test(r.url)),
      cesiumScriptInHead: await page.evaluate(() =>
        [...document.head.querySelectorAll("script[src],link[rel=stylesheet]")]
          .map((el) => el.getAttribute("src") ?? el.getAttribute("href"))
          .filter((h) => h && h.includes("cesium")),
      ),
      cesiumBaseUrl: await page.evaluate(() => window.CESIUM_BASE_URL ?? null),
      cesiumWorkerBootstrapStatus: await page.evaluate(async () => {
        const base = window.CESIUM_BASE_URL ?? "cesium/";
        const res = await fetch(`${base}Workers/cesiumWorkerBootstrapper.js`, { method: "HEAD" });
        return res.status;
      }),
      allRequests: requests.map((r) => r.url),
    };
    await context.close();
  }

  // ------------------------------------------------------------ 2. progressive
  {
    const { context, page, requests } = await newRun(browser, { stub: { delayMs: 500 } });
    await page.goto(URL_BASE, { waitUntil: "networkidle" });
    await submit(page);
    await page.waitForSelector(".view", { timeout: 20000 });

    const timeline = [];
    const t0 = Date.now();
    const seen = new Set();
    for (let i = 0; i < 120; i++) {
      const slots = await readSlots(page);
      const key = JSON.stringify(slots.map((s) => [s.phase, s.hasImg]));
      if (!seen.has(key)) {
        seen.add(key);
        timeline.push({ atMs: Date.now() - t0, slots });
      }
      if (slots.length && slots.every((s) => s.phase === "ready" || s.phase === "failed")) break;
      await page.waitForTimeout(100);
    }

    evidence.cases.progressive = {
      what: "Four directions revealed one at a time, from a stubbed session.",
      timeline,
      distinctPartialStates: timeline.filter(
        (t) =>
          t.slots.some((s) => s.phase === "ready") &&
          t.slots.some((s) => s.phase !== "ready"),
      ).length,
      planDiagramPresentBeforeAnyImagery: timeline[0]
        ? await page.$$eval(".plan__axis", (g) => g.length)
        : 0,
      attributionText: await page.textContent(".attribution__line").catch(() => null),
      providerRequests: providerRequests(requests).map((r) => r.url),
      allNonLocalRequests: requests
        .map((r) => r.url)
        .filter((u) => !u.startsWith(URL_BASE)),
    };
    await context.close();
  }

  // ---------------------------------------------------------------- 3. partial
  {
    const { context, page, requests } = await newRun(browser, {
      stub: { delayMs: 150, script: { V3: "fail" } },
    });
    await page.goto(URL_BASE, { waitUntil: "networkidle" });
    await submit(page);
    await page.waitForSelector(".view", { timeout: 20000 });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".view")].every(
          (f) => f.getAttribute("data-phase") === "ready" || f.getAttribute("data-phase") === "failed",
        ),
      null,
      { timeout: 20000 },
    );
    const slots = await readSlots(page);
    evidence.cases.partial = {
      what: "One direction fails permanently; the other three must survive and stay useful.",
      slots,
      readyCount: slots.filter((s) => s.phase === "ready").length,
      failedPanesContainingAnImage: slots.filter((s) => s.phase === "failed" && s.hasImg).length,
      failedPanesKeepingTheirLabel: slots.filter((s) => s.phase === "failed" && s.label).length,
      resultNotes: await page.$$eval(".notes li", (li) => li.map((e) => e.textContent)),
      renderAgainOffered: await page.isVisible(".btn--quiet").catch(() => false),
      providerRequests: providerRequests(requests).map((r) => r.url),
    };
    await context.close();
  }

  // --------------------------------------------------------- 4. session failed
  {
    const { context, page, requests } = await newRun(browser, {
      stub: { openFails: true },
    });
    const consoleErrors = [];
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    await page.goto(URL_BASE, { waitUntil: "networkidle" });
    await submit(page);
    await page.waitForSelector(".view", { timeout: 20000 });
    await page.waitForTimeout(1500);
    const slots = await readSlots(page);
    evidence.cases.sessionFailed = {
      what: "The session never opens. Nothing may be drawn in place of the imagery.",
      slots,
      resultNotes: await page.$$eval(".notes li", (li) => li.map((e) => e.textContent)),
      panesContainingAnImage: slots.filter((s) => s.hasImg).length,
      imgElementsAnywhereInResult: await page.$$eval(".result img", (e) => e.length),
      canvasElementsAnywhereInResult: await page.$$eval(".result canvas", (e) => e.length),
      consoleErrorsMentioningAKey: consoleErrors.filter((t) => /key=[^&\s]/i.test(t)),
      consoleErrors,
      providerRequests: providerRequests(requests).map((r) => r.url),
    };
    await context.close();
  }

  // ----------------------------------------------------------------- 5. mobile
  {
    const { context, page, requests } = await newRun(browser, {
      viewport: { width: 390, height: 844 },
      stub: { delayMs: 120 },
    });
    await page.goto(URL_BASE, { waitUntil: "networkidle" });
    await submit(page);
    await page.waitForSelector(".view", { timeout: 20000 });
    await page.waitForTimeout(2500);
    evidence.cases.mobile = {
      what: "390x844. The drawing set must stack, and nothing may overflow horizontally.",
      documentScrollWidth: await page.evaluate(() => document.documentElement.scrollWidth),
      viewportWidth: 390,
      horizontalOverflow: await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      ),
      panesPerRow: await page.$$eval(".views .view", (figs) => {
        const tops = figs.map((f) => Math.round(f.getBoundingClientRect().top));
        return tops.length / new Set(tops).size;
      }),
      planDiagramWidth: await page
        .$eval(".plan__svg", (el) => Math.round(el.getBoundingClientRect().width))
        .catch(() => null),
      providerRequests: providerRequests(requests).map((r) => r.url),
    };
    await context.close();
  }

  await browser.close();

  const total = Object.values(evidence.cases).reduce(
    (n, c) => n + (c.providerRequests?.length ?? 0),
    0,
  );
  evidence.totalProviderRequestsAcrossAllCases = total;
  writeFileSync(
    join(OUT, "27b-browser-trace.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify(evidence.cases.landing, null, 2));
  console.log("\ntotal provider requests across all cases:", total);
  if (total !== 0) {
    console.error("FAIL: a provider request was made. That is both a bug and a charge.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
