// Frugal 3D-tile renderer: capture four static frames from ONE Cesium session.
//
// Cost discipline (see README "Cost-cap notes"): Google Photorealistic 3D Tiles
// is the only metered resource (~1,000 tile-events/mo free). A live, always-on
// globe would stream tiles continuously. Instead we spin up a single offscreen
// Cesium viewer, load the Google tileset ONCE, move the camera to each of the
// four cardinal vantages, wait for tiles to settle, capture a static PNG per
// view, then tear the viewer down. Four still captures per address, then the
// viewer is gone — no ongoing tile traffic. Captures are handed to the cache so
// repeat lookups render nothing at all.
//
// This module is only ever imported behind the key gate; it is never on the
// no-key code path, so a missing key can't reach real tile calls.

import {
  Viewer,
  Cesium3DTileset,
  createGooglePhotorealistic3DTileset,
  Ion,
  ImageryLayer,
} from "cesium";
import type { CameraView, ViewSlot } from "../lib/types";
import { applyCameraView } from "./cesiumCamera";

export interface CaptureResult {
  slot: ViewSlot;
  /** data: URL PNG of the rendered frame, with attribution baked along the bottom. */
  dataUrl: string;
  /**
   * The data attributions Google returned for the tiles actually displayed in
   * this frame (e.g. ["Google", "Vexcel Imaging US, Inc."]). Kept as separate
   * credits rather than one joined string so they can be de-duplicated across
   * frames without splitting on a comma that belongs inside a company name.
   * Map Tiles API policies require these to be displayed with the imagery.
   */
  attribution: string[];
}

/** Text we are required to show alongside the imagery (policy: logo or the words). */
const GOOGLE_ATTRIBUTION = "Google Maps";

export interface RenderOptions {
  /** Google Map Tiles API key (Photorealistic 3D Tiles). Required. */
  apiKey: string;
  /** Capture size in device pixels. Small keeps memory + capture cost down. */
  width?: number;
  height?: number;
  /** Max ms to wait for tiles to settle per view before capturing anyway. */
  settleTimeoutMs?: number;
  /**
   * Aborts the session early (superseded plan, unmount, StrictMode's double
   * effect invocation). Without this, an orphaned run keeps its own Cesium
   * viewer and WebGL context alive and streaming tiles even after its caller
   * has stopped listening, which is how two concurrent viewers end up
   * fighting over the GPU (framebufferTexture2D "does not belong to this
   * context" errors) instead of the second one just winning cleanly.
   */
  signal?: AbortSignal;
}

class RenderAbortedError extends Error {
  constructor() {
    super("Tile render aborted (superseded).");
    this.name = "RenderAbortedError";
  }
}

/**
 * Wait until the tileset is fully settled for the current view, or a timeout
 * elapses.
 *
 * Design choices:
 *
 * 1. Synchronous render() in the drive loop — requestRenderMode offscreen
 *    canvases may have their rAF callbacks throttled by the browser.  Calling
 *    viewer.render() directly drives tile-network round-trips synchronously,
 *    independent of the animation scheduler.
 *
 * 2. Debounce on loadProgress(0,0) — the event fires (0,0) both on startup
 *    (before any tiles are requested) and briefly between tile batches while
 *    the renderer refines the LOD. A 2-second grace period after seeing (0,0)
 *    lets the second wave of detail tiles start before we declare done.
 *
 * 3. seenNonZero guard — never accept the initial (0,0) firing as "settled".
 */
function waitForTiles(
  viewer: Viewer,
  tileset: Cesium3DTileset,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let seenNonZero = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };

    if (signal) {
      if (signal.aborted) {
        finish();
        return;
      }
      signal.addEventListener("abort", finish, { once: true });
    }

    const scheduleSettle = () => {
      if (settleTimer) clearTimeout(settleTimer);
      // Grace period: if no new tile activity starts in this window, we
      // consider the scene settled and capture. Dense areas (lower Manhattan)
      // never fully quiesce at a useful screen-space-error — there's always
      // one more refinement pass available — so this triggers the hard
      // timeout below in practice. Measured captures at that timeout already
      // look complete, so the grace period only needs to be long enough to
      // not cut off a real burst of new tiles, not to prove total silence.
      settleTimer = setTimeout(finish, 900);
    };

    const cancelSettle = () => {
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    };

    const removeLoadProgress = tileset.loadProgress.addEventListener(
      (pendingRequests: number, tilesProcessing: number) => {
        if (pendingRequests > 0 || tilesProcessing > 0) {
          seenNonZero = true;
          cancelSettle(); // tiles still loading — restart the grace window
        } else if (seenNonZero) {
          scheduleSettle(); // tiles quiesced — start 2 s grace window
        }
      },
    );

    // allTilesLoaded is a belt-and-suspenders complement: if the tileset emits
    // this, tiles definitely loaded, so start the grace window immediately.
    const removeAllLoaded = tileset.allTilesLoaded.addEventListener(() => {
      seenNonZero = true;
      scheduleSettle();
    });

    const hardTimer = setTimeout(finish, timeoutMs);

    // Drive tile streaming with synchronous viewer.render() so the tile
    // network round-trips advance even when rAF is throttled for offscreen
    // canvases.  30 ms ≈ 33 fps — enough throughput without excess quota cost.
    const renderInterval = setInterval(() => {
      if (done) return;
      try {
        viewer.scene.requestRender();
        viewer.render();
      } catch {
        // Ignore errors from a partially-torn-down viewer.
      }
    }, 30);

    const cleanup = () => {
      clearTimeout(hardTimer);
      cancelSettle();
      removeLoadProgress();
      removeAllLoaded();
      clearInterval(renderInterval);
      signal?.removeEventListener("abort", finish);
    };

    viewer.scene.requestRender();
    viewer.render();
  });
}

/**
 * Read the aggregated data attribution for the frame Cesium just drew.
 *
 * Cesium writes the credits for the current frame into `creditDisplay.container`
 * (that is what `showCreditsOnScreen: true` populates). Google's Photorealistic
 * 3D Tiles return their attribution per tile in the glTF `asset.copyright`
 * field, and the Map Tiles API policy is to "aggregate, sort, and display in a
 * line, all attributions for displayed tiles" — Cesium already aggregates and
 * de-duplicates them, so we read the aggregate rather than re-implement it.
 */
export function readAttribution(viewer: Viewer): string[] {
  const container = viewer.creditDisplay?.container;
  if (!container) return [];
  // Cesium puts one child element per on-screen credit inside
  // `.cesium-credit-textContainer`, separated by `.cesium-credit-delimiter`
  // spans, with the lightbox "Data attribution" link as a sibling of the
  // container. Enumerating the children (rather than reading textContent off
  // the whole widget) is what keeps the delimiter and the expand link out of
  // the string and keeps individual credits separable for de-duplication.
  const textContainer = container.querySelector<HTMLElement>(
    ".cesium-credit-textContainer",
  );
  const seen = new Set<string>();
  for (const child of Array.from(textContainer?.children ?? [])) {
    if (child.classList.contains("cesium-credit-delimiter")) continue;
    const text = (child.textContent ?? "").trim();
    if (text && text !== "Data attribution") seen.add(text);
  }
  return Array.from(seen).sort();
}

/**
 * Compose the WebGL frame plus a bottom attribution bar into a single PNG.
 *
 * The attribution is baked into the pixels on purpose: a `<img src=data:...>`
 * detached from the Cesium widget would otherwise carry no credit at all, and
 * the policy requires the attribution to be displayed with the imagery. The bar
 * sits below/over the bottom edge of the frame and is never overlapped by other
 * UI. Exported for the render-path unit test.
 */
export function composeAttributedPng(
  source: HTMLCanvasElement,
  attribution: string[],
): string {
  const FONT =
    "12px system-ui, -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif";
  const PAD = 8;
  const LINE_H = 15;

  const text =
    attribution.length > 0
      ? `${GOOGLE_ATTRIBUTION} · ${attribution.join(", ")}`
      : GOOGLE_ATTRIBUTION;

  // Measure first so the bar is tall enough to show the credits IN FULL. The
  // policy asks for the attributions "in full"; truncating them to fit would be
  // the wrong trade, so the image grows instead.
  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) throw new Error("2D context unavailable for attribution compositing");
  measure.font = FONT;
  const maxWidth = source.width - PAD * 2;
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    const next = current ? `${current} ${word}` : word;
    if (measure.measureText(next).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);

  const barH = lines.length * LINE_H + PAD;
  const out = document.createElement("canvas");
  out.width = source.width;
  out.height = source.height + barH;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable for attribution compositing");

  ctx.drawImage(source, 0, 0);
  ctx.fillStyle = "#0b0d10";
  ctx.fillRect(0, source.height, out.width, barH);
  ctx.fillStyle = "#e8eaed";
  ctx.font = FONT;
  ctx.textBaseline = "top";
  lines.forEach((line, i) => {
    ctx.fillText(line, PAD, source.height + PAD / 2 + i * LINE_H);
  });

  return out.toDataURL("image/png");
}

/**
 * Render the four views for a plan into static PNG data URLs using a single,
 * disposable Cesium session. The offscreen container is created and removed
 * internally so callers just await the captures.
 */
export async function renderFourViews(
  views: CameraView[],
  opts: RenderOptions,
): Promise<CaptureResult[]> {
  const {
    apiKey,
    width = 800,
    height = 600,
    // 9 s was measured to be too short: the last view of a four-view run was
    // still at a coarse LOD when it was captured, which reads as "blocky" —
    // exactly the impression this project must never give, even though the
    // geometry is real photogrammetry throughout. 16 s lets the mesh refine.
    // Renderer tile requests inside an open session are unmetered, so the only
    // cost of waiting longer is wall-clock time.
    settleTimeoutMs = 16000,
    signal,
  } = opts;

  const checkAborted = () => {
    if (signal?.aborted) throw new RenderAbortedError();
  };
  checkAborted();

  // Cesium requires *some* Ion token to boot even when we only use Google tiles.
  // Empty string disables Ion's default assets; the Google tileset is loaded
  // explicitly below with the Maps key, so no Ion asset is fetched.
  Ion.defaultAccessToken = "";

  // Offscreen host: on-DOM (WebGL needs a real canvas) but visually hidden.
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:-99999px;top:0;pointer-events:none;";
  host.style.width = `${width}px`;
  host.style.height = `${height}px`;
  document.body.appendChild(host);

  let viewer: Viewer | null = null;
  let destroyed = false;
  const destroyNow = () => {
    if (destroyed) return;
    destroyed = true;
    try {
      viewer?.destroy();
    } catch {
      // Already torn down or mid-teardown — nothing more to do.
    }
  };
  // Belt-and-suspenders: an abort mid-await (tileset creation, the warmup
  // delay) is only caught by checkAborted() at the next checkpoint, which can
  // be seconds away. This listener tears the WebGL context down the instant
  // the signal fires, so an orphaned run can never overlap a fresh one on the
  // GPU — that overlap is what produces cross-context WebGL errors.
  signal?.addEventListener("abort", destroyNow, { once: true });

  try {
    viewer = new Viewer(host, {
      // Strip every default widget: this is a render surface, not a UI.
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      selectionIndicator: false,
      infoBox: false,
      // We drive rendering explicitly (request-render) to avoid a render loop
      // that would keep streaming tiles.
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      // No default Bing/Ion base imagery layer — we only want the Google mesh.
      // This also keeps any non-Google map service out of the same view, which
      // Maps Platform ToS §3.2.3(e) ("No Use With Non-Google Maps") requires.
      baseLayer: false as unknown as ImageryLayer,
      // WebGL clears its drawing buffer after compositing unless asked not to,
      // so `canvas.toDataURL()` can come back blank/black depending on when the
      // browser composites. Readback is the whole point of this module, so the
      // buffer must be preserved. (Verified in Chrome: without this the capture
      // is not reliable frame to frame.)
      contextOptions: { webgl: { preserveDrawingBuffer: true } },
    });

    viewer.scene.globe.show = false; // hide the default ellipsoid globe.

    // `showCreditsOnScreen: true` is what Google's own Photorealistic 3D Tiles
    // sample sets, and the docs require "a 3D Tiles renderer that supports the
    // display of copyright attribution". It makes Cesium surface the per-tile
    // `asset.copyright` strings; we read them back below and composite them
    // into the frame so the attribution can never be separated from the pixels.
    // https://developers.google.com/maps/documentation/tile/3d-tiles
    // https://developers.google.com/maps/documentation/tile/policies
    const tileset = await createGooglePhotorealistic3DTileset(
      { key: apiKey },
      { showCreditsOnScreen: true },
    );
    checkAborted(); // may have been destroyed by the listener while awaiting
    // Lower the LOD error threshold below Cesium's default (16) to load
    // building-level detail from mid-altitude. 4 was measured to be far too
    // aggressive: one address blew past 11,000 tile requests and took ~4
    // minutes to settle against the ~1,000/mo free-tier cap this app exists
    // to respect. 10 is a middle ground — still resolves building facades,
    // without the runaway refinement cost of the lowest settings.
    tileset.maximumScreenSpaceError = 10;
    viewer.scene.primitives.add(tileset);

    // Position the camera at the first view before warmup so the warm-up
    // period streams tiles for the actual vantage, not a default globe position.
    if (views.length > 0) applyCameraView(viewer.camera, views[0]);

    // Allow tiles to begin streaming.
    viewer.scene.requestRender();
    await new Promise<void>((r) => setTimeout(r, 3000));
    checkAborted();

    const captures: CaptureResult[] = [];
    for (const view of views) {
      checkAborted();
      applyCameraView(viewer.camera, view);
      viewer.scene.requestRender();
      await waitForTiles(viewer, tileset, settleTimeoutMs, signal);
      checkAborted();

      // After tiles are settled, give the GPU time to finish uploading textures
      // before reading back the canvas — a single render() call may fire before
      // the texture upload queue drains. Two render + 1 s gives textures time.
      viewer.scene.requestRender();
      await new Promise<void>((r) => setTimeout(r, 800));
      viewer.scene.requestRender();
      await new Promise<void>((r) => setTimeout(r, 200));
      viewer.render();

      // Read the attributions Google returned for the tiles in THIS frame.
      // Cesium rebuilds the credit container each frame from the tiles it just
      // drew, so this is per-view data, not a constant.
      const attribution = readAttribution(viewer);

      let dataUrl: string;
      try {
        dataUrl = composeAttributedPng(viewer.canvas, attribution);
      } catch (err) {
        // SecurityError: WebGL canvas tainted by cross-origin tile textures.
        // Google Photorealistic 3D Tiles must be served with ACAO headers for
        // readback to work. If this fires, verify that tile responses include
        // Access-Control-Allow-Origin (check DevTools Network → tile request
        // → Response Headers). A CORS proxy is required if headers are absent.
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Canvas readback blocked (CORS taint): ${msg}`);
      }
      captures.push({ slot: view.slot, dataUrl, attribution });
    }
    return captures;
  } finally {
    signal?.removeEventListener("abort", destroyNow);
    destroyNow();
    host.remove();
  }
}
