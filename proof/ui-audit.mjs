#!/usr/bin/env node
// Measures the things a screenshot cannot: text contrast against the ground it
// is actually painted on, the *rendered* size of type inside a scaled SVG, and
// whether the required Google attribution survives to the edge of its box at
// every supported viewport.
//
// It runs against a KEYLESS server on purpose. Everything it measures —
// typography, colour, layout, the plan drawing, the empty-frame states — is
// produced by the geometry half of the pipeline, which needs no imagery source.
// Running it keyless costs zero provider sessions, so it can be re-run as often
// as a change needs re-checking.
//
// Usage:
//   node apps/27b/proof/ui-audit.mjs --url=http://localhost:5291/ --label=before
//
// Options: --url --label --out

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { launchChrome, attachToPage, sleep } from "../../portfolio/qa/cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) =>
  argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=") ?? d;

const URL_BASE = arg("url", "http://localhost:5291/");
const LABEL = arg("label", "run");
const OUT = arg("out", join(HERE, "ui-audit"));

/**
 * Viewports the app claims to support. 1440x900 is the size the portfolio
 * embeds at on a laptop; 320 is the narrowest width any of the layout's
 * breakpoints were written for.
 */
const VIEWPORTS = [
  { name: "320x640", width: 320, height: 640 },
  { name: "375x812", width: 375, height: 812 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
];

/** Selectors whose contrast is a pass/fail, with the WCAG rule that applies. */
const CONTRAST_TARGETS = [
  ".masthead__mark",
  ".masthead__tag",
  ".masthead__sub",
  ".presets__label",
  ".preset__name",
  ".preset__detail",
  ".framing",
  ".field__label",
  ".foot__sources",
  ".plan__caption",
  ".result__frame",
  ".notes",
  ".lead__bearing",
  ".lead__quality",
  ".lead__note",
  ".thumb__compass",
  ".thumb__state",
  ".attribution__line",
  ".disclosure summary",
  ".result__meta--dim",
];

/**
 * Injected into the page: WCAG 2.x relative luminance and contrast, plus the
 * compositing the browser does but `getComputedStyle` will not report — an
 * element with `opacity` or a translucent colour is measured against whatever
 * is actually behind it, not against its own declared colour.
 */
const PAGE_HELPERS = `
(() => {
  if (window.__audit) return true;
  // Two serialisations, because a computed value that came from color-mix()
  // comes back as color(srgb 0..1) rather than rgb(0..255), and reading only
  // the second silently loses exactly the colour this audit exists to check.
  const parse = (c) => {
    const s = String(c);
    const srgb = s.match(/color\\(srgb ([^)]+)\\)/);
    if (srgb) {
      const p = srgb[1].split(/[\\s/]+/).filter(Boolean).map(Number);
      return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 };
    }
    const m = s.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const chan = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const lum = ({ r, g, b }) => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  /** The first opaque background painted behind el, composited downward. */
  const groundOf = (el) => {
    const stack = [];
    for (let n = el; n; n = n.parentElement) {
      const bg = parse(getComputedStyle(n).backgroundColor);
      if (bg && bg.a > 0) {
        stack.push(bg);
        if (bg.a === 1) break;
      }
    }
    let ground = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i -= 1) ground = over(stack[i], ground);
    return ground;
  };
  /** Cumulative opacity from el up to the root. */
  const alphaOf = (el) => {
    let a = 1;
    for (let n = el; n; n = n.parentElement) a *= Number(getComputedStyle(n).opacity || 1);
    return a;
  };
  window.__audit = {
    contrast(sel) {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const fg = parse(cs.color);
      const ground = groundOf(el);
      const effective = over({ ...fg, a: fg.a * alphaOf(el) }, ground);
      const l1 = lum(effective);
      const l2 = lum(ground);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const px = parseFloat(cs.fontSize);
      const weight = Number(cs.fontWeight) || 400;
      // WCAG "large text": >= 24px, or >= 18.66px when bold.
      const large = px >= 24 || (px >= 18.66 && weight >= 700);
      return {
        selector: sel,
        color: cs.color,
        effectiveColor: 'rgb(' + [effective.r, effective.g, effective.b].map((v) => Math.round(v)).join(', ') + ')',
        ground: 'rgb(' + [ground.r, ground.g, ground.b].map((v) => Math.round(v)).join(', ') + ')',
        fontPx: +px.toFixed(2),
        fontWeight: weight,
        large,
        required: large ? 3 : 4.5,
        ratio: +ratio.toFixed(2),
        passes: ratio >= (large ? 3 : 4.5),
      };
    },
    /** Rendered size of SVG text, which scales with the viewBox. */
    svgText(sel) {
      const out = [];
      for (const el of document.querySelectorAll(sel)) {
        const cs = getComputedStyle(el);
        const ctm = el.getScreenCTM();
        const scale = ctm ? Math.hypot(ctm.a, ctm.b) : 1;
        const declared = parseFloat(cs.fontSize);
        out.push({
          selector: sel,
          text: el.textContent,
          declaredPx: +declared.toFixed(2),
          userUnitScale: +scale.toFixed(4),
          renderedCssPx: +(declared * scale).toFixed(2),
          renderedDevicePx: +(declared * scale * window.devicePixelRatio).toFixed(2),
        });
      }
      return out;
    },
    /** Is every pixel of el inside every clipping ancestor and the viewport? */
    clipping(sel) {
      const out = [];
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        let clippedBy = null;
        for (let n = el.parentElement; n && !clippedBy; n = n.parentElement) {
          const cs = getComputedStyle(n);
          const hides = /hidden|clip|auto|scroll/.test(cs.overflow + cs.overflowX + cs.overflowY);
          if (!hides) continue;
          const pr = n.getBoundingClientRect();
          if (r.left < pr.left - 0.5 || r.right > pr.right + 0.5 ||
              r.top < pr.top - 0.5 || r.bottom > pr.bottom + 0.5) {
            clippedBy = n.className || n.tagName;
          }
        }
        out.push({
          selector: sel,
          text: (el.textContent || '').slice(0, 90),
          rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
          offRight: +Math.max(0, r.right - document.documentElement.clientWidth).toFixed(1),
          clippedBy,
        });
      }
      return out;
    },
    /**
     * For each displayed frame: how much of the source image the box actually
     * shows. The Google credit is baked into the bottom of the source PNG, so
     * any vertical crop takes it away.
     */
    frames() {
      return [...document.querySelectorAll('img.view__canvas, img.thumb__img')].map((img) => {
        const r = img.getBoundingClientRect();
        const fit = getComputedStyle(img).objectFit;
        const nw = img.naturalWidth, nh = img.naturalHeight;
        let shownFraction = 1;
        if (nw && nh && r.width && r.height) {
          if (fit === 'cover') {
            const s = Math.max(r.width / nw, r.height / nh);
            shownFraction = Math.min(1, (r.height / s) / nh);
          } else if (fit === 'contain' || fit === 'scale-down') {
            shownFraction = 1;
          } else {
            shownFraction = 1; // fill: the whole source, distorted at worst
          }
        }
        return {
          cls: img.className,
          natural: { w: nw, h: nh },
          box: { w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
          objectFit: fit,
          verticalFractionShown: +shownFraction.toFixed(4),
          creditVisible: shownFraction >= 0.9999,
        };
      });
    },
    docOverflowsX() {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth + 0.5;
    },
  };
  return true;
})()
`;

const chrome = await launchChrome({ headless: true });
const results = { label: LABEL, url: URL_BASE, ranAt: new Date().toISOString(), viewports: [] };

try {
  const page = await attachToPage(chrome.port);
  await page.send("Runtime.enable");
  await page.send("Log.enable");
  await page.send("Network.enable");

  const consoleProblems = [];
  page.on("Runtime.consoleAPICalled", (e) => {
    if (e.type !== "error" && e.type !== "warning") return;
    consoleProblems.push({
      level: e.type,
      text: e.args.map((a) => a.value ?? a.description ?? a.type).join(" "),
    });
  });
  page.on("Log.entryAdded", ({ entry }) => {
    if (entry.level !== "error" && entry.level !== "warning") return;
    consoleProblems.push({ level: entry.level, text: entry.text, url: entry.url });
  });

  const netFailures = [];
  page.on("Network.responseReceived", ({ response }) => {
    if (response.status >= 400) netFailures.push({ url: response.url, status: response.status });
  });

  // The favicon: fetched directly, because a browser only asks for /favicon.ico
  // when the document declares no icon of its own, and both outcomes have to be
  // distinguishable here.
  const iconProbe = {};
  for (const path of ["favicon.ico", "favicon.svg"]) {
    try {
      const r = await fetch(new URL(path, URL_BASE));
      iconProbe[path] = { status: r.status, type: r.headers.get("content-type"), bytes: Number(r.headers.get("content-length")) || (await r.arrayBuffer()).byteLength };
    } catch (err) {
      iconProbe[path] = { error: String(err) };
    }
  }
  results.favicon = iconProbe;

  for (const vp of VIEWPORTS) {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await page.goto(URL_BASE);
    await sleep(900);
    await page.eval(PAGE_HELPERS);

    results.faviconDeclared = JSON.parse(
      await page.eval(
        `JSON.stringify([...document.querySelectorAll('link[rel~="icon"]')].map((l) => ({ rel: l.rel, href: l.getAttribute('href'), type: l.type })))`,
      ),
    );

    const idle = JSON.parse(
      await page.eval(
        `JSON.stringify({
          contrast: ${JSON.stringify(CONTRAST_TARGETS)}.map((s) => window.__audit.contrast(s)).filter(Boolean),
          framingSentences: (document.querySelector('.framing')?.textContent ?? '')
            .split(/(?<=\\.)\\s+/).filter((s) => s.trim().length),
          overflowsX: window.__audit.docOverflowsX(),
        })`,
      ),
    );

    // Resolve a real building so the plan drawing, the notes and the frame
    // boxes exist. Keyless, so no imagery is requested and no session opens.
    await page.eval(`(() => {
      const set = (el, v) => {
        const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
        d.set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      set(document.querySelector("#addr"), "1 W 72nd St, Manhattan, New York, NY 10023");
      set(document.querySelector("#floor"), "7");
      document.querySelector(".form .btn").click();
      return true;
    })()`);

    let resolved = false;
    for (let i = 0; i < 40 && !resolved; i += 1) {
      await sleep(500);
      resolved = (await page.eval(`Boolean(document.querySelector(".plan__svg") || document.querySelector(".state__title"))`)) === true;
    }
    await page.eval(`(() => { const d = document.querySelector('.disclosure'); if (d) d.open = true; return true; })()`);
    await sleep(300);
    await page.eval(PAGE_HELPERS);

    const result = JSON.parse(
      await page.eval(
        `JSON.stringify({
          resolved: Boolean(document.querySelector('.plan__svg')),
          contrast: ${JSON.stringify(CONTRAST_TARGETS)}.map((s) => window.__audit.contrast(s)).filter(Boolean),
          planLabels: window.__audit.svgText('.plan__label'),
          planCaption: window.__audit.clipping('.plan__caption'),
          attribution: window.__audit.clipping('.attribution__line'),
          frames: window.__audit.frames(),
          notes: [...document.querySelectorAll('.notes li')].map((n) => n.textContent),
          overflowsX: window.__audit.docOverflowsX(),
        })`,
      ),
    );

    results.viewports.push({ viewport: vp, idle, result });
  }

  results.consoleProblems = consoleProblems;
  results.networkFailures = netFailures;

  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `${LABEL}.json`);
  writeFileSync(file, JSON.stringify(results, null, 2) + "\n");

  const worst = results.viewports
    .flatMap((v) => [...v.idle.contrast, ...v.result.contrast])
    .filter((c) => !c.passes);
  console.error(`[ui-audit ${LABEL}] ${file}`);
  console.error(`[ui-audit ${LABEL}] ${worst.length} contrast failure(s)`);
  for (const c of [...new Map(worst.map((c) => [c.selector, c])).values()]) {
    console.error(`  ${c.selector.padEnd(22)} ${c.ratio}:1 (needs ${c.required}) at ${c.fontPx}px`);
  }
  const labels = results.viewports.flatMap((v) => v.result.planLabels ?? []);
  if (labels.length) {
    const min = Math.min(...labels.map((l) => l.renderedCssPx));
    console.error(`[ui-audit ${LABEL}] smallest .plan__label rendered at ${min} CSS px`);
  }
  const cropped = results.viewports.flatMap((v) => v.result.frames ?? []).filter((f) => !f.creditVisible);
  console.error(`[ui-audit ${LABEL}] ${cropped.length} frame(s) with a cropped credit bar`);
} finally {
  await chrome.close();
}
