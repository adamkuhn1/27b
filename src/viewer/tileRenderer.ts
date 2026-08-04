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
import type { CameraView, Cardinal } from "../lib/types";
import { applyCameraView } from "./cesiumCamera";

export interface CaptureResult {
  cardinal: Cardinal;
  /** data: URL PNG of the rendered frame. */
  dataUrl: string;
}

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
 * Render the four cardinal views for a plan into static PNG data URLs using a
 * single, disposable Cesium session. The offscreen container is created and
 * removed internally so callers just await the captures.
 */
export async function renderFourViews(
  views: CameraView[],
  opts: RenderOptions,
): Promise<CaptureResult[]> {
  const {
    apiKey,
    width = 800,
    height = 600,
    settleTimeoutMs = 9000,
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
      baseLayer: false as unknown as ImageryLayer,
    });

    // Attribution must stay visible on any displayed frame (Maps ToS). Cesium's
    // credit container renders Google's attribution into the canvas capture.
    viewer.scene.globe.show = false; // hide the default ellipsoid globe.

    const tileset = await createGooglePhotorealistic3DTileset({ key: apiKey });
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

      let dataUrl: string;
      try {
        dataUrl = viewer.canvas.toDataURL("image/png");
      } catch (err) {
        // SecurityError: WebGL canvas tainted by cross-origin tile textures.
        // Google Photorealistic 3D Tiles must be served with ACAO headers for
        // readback to work. If this fires, verify that tile responses include
        // Access-Control-Allow-Origin (check DevTools Network → tile request
        // → Response Headers). A CORS proxy is required if headers are absent.
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Canvas readback blocked (CORS taint): ${msg}`);
      }
      captures.push({ cardinal: view.cardinal, dataUrl });
    }
    return captures;
  } finally {
    signal?.removeEventListener("abort", destroyNow);
    destroyNow();
    host.remove();
  }
}
