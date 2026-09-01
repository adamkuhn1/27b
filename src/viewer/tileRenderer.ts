// Frugal 3D-tile renderer: capture four static frames from ONE Cesium session,
// and hand each one over the moment it exists.
//
// Cost discipline: Google Photorealistic 3D Tiles is the only metered resource.
// The billable unit is the **session** (one root tileset request), not the
// frame: "Timed session tokens allow for up to three hours of renderer tile
// requests from a single root tileset request", and "Tile requests for
// Photorealistic 3D Tiles don't impact your daily quota" (Map Tiles usage &
// billing, re-read 2026-08-05). So we spin up a single offscreen Cesium
// viewer, load the Google tileset ONCE, move the camera to each of the four
// facade vantages, wait for tiles to settle, capture a static PNG per view,
// then tear the viewer down. One billable event per render, no ongoing tile
// traffic, and an in-session retry of a failed direction is free.
//
// The captures are NOT cached anywhere. Google Maps Platform ToS §3.2.3(b)
// forbids caching Google Maps Content, and the Maps Service Specific Terms
// grant no Map Tiles allowance (re-verified 2026-08-04). A repeat lookup of
// the same address is a new render and a new billable root-tileset request —
// the licence-correct trade, not an oversight.
//
// No pixel of any frame is ever analysed, by a model or otherwise (the Map
// Tiles ToS prohibits it, and the product does not need it). The one guard
// that decides whether a frame is real counts TRIANGLES DRAWN — our own
// renderer's scene statistics — never image content.
//
// This module is only ever imported dynamically after a plan exists and a key
// is configured; it is never on the no-key code path.

import {
  Cartesian3,
  Cesium3DTileset,
  createGooglePhotorealistic3DTileset,
  ImageryLayer,
  Ion,
  Math as CesiumMath,
  Viewer,
} from "cesium";
// Imported here, not in index.html, so it travels in this lazily-imported
// chunk. The widget stylesheet is only meaningful once a `Viewer` exists.
import "cesium/Build/Cesium/Widgets/widgets.css";
import type { CameraView, CaptureResult, ViewSlot } from "../lib/types";
import { barMetrics, layoutAttributionBar } from "./attributionBar";

// ---------------------------------------------------------------------------
// Tuning — every value chosen against real captures in the 2026-08 bake-off
// ---------------------------------------------------------------------------

export const RENDER_TUNING = {
  /**
   * Capture size in real pixels. 800x600 was kept after a blinded experiment
   * REJECTED 2x/1.5x supersampling: on three of four test buildings the
   * baseline looked sharper than 1600x1200 (the extra screen-space demand
   * outran what tiles arrived before settle), at 2.5-3.2x the wall clock. At
   * these standoffs the provider's mesh is the limiting factor, not our
   * raster. Do not re-run that experiment.
   */
  width: 800,
  height: 600,
  /** Max ms to wait for tiles to settle per view before capturing anyway. */
  settleTimeoutMs: 16000,
  /**
   * Cesium's LOD threshold. Lower = finer tiles, more requests, more memory.
   * 8 and 6 were captured: 6 costs 81% more renderer tile requests for a frame
   * indistinguishable from 10.
   */
  maximumScreenSpaceError: 10,
  /**
   * Horizontal field of view, degrees. 75 — not Cesium's default 60 — was the
   * only tuning delta in the bake-off that visibly improved more than one
   * building. At 60, a camera six metres off a facade frames almost nothing
   * but the wall opposite (the provider mesh's worst case); at 75 the same
   * capture includes roofline, sky, and street, and reads as a view out of a
   * window. It is also cheaper: a wider frame needs less angular resolution
   * (~26% fewer renderer tile requests, measured). 90 stretches at the edges.
   */
  fovDeg: 75,
} as const;

/**
 * Quiet period after tile activity reaches zero before a capture is called
 * settled. Long enough not to cut off the next refinement burst, short enough
 * that a genuinely finished view is not held back.
 */
const SETTLE_GRACE_MS = 900;

/**
 * How often to drive a frame while streaming tiles (~33 fps). A 3D tileset
 * only discovers and requests tiles during `Scene.render()`; under
 * `requestRenderMode` no frames happen unless somebody asks, so "waiting for
 * tiles" without pumping frames loads nothing.
 */
const PUMP_INTERVAL_MS = 30;

/** How long to stream tiles before the first capture. */
const WARMUP_MS = 3000;

/**
 * Multiplier on the settle budget for the FIRST capture of a session. Later
 * views run against a tileset the earlier waits already populated; the first
 * starts from a tileset that knows nothing but its root. Measured: without
 * this, the first direction of a high-floor session was regularly captured as
 * sky over a coarse global mesh while later directions looked right.
 */
const FIRST_CAPTURE_SETTLE_FACTOR = 2.5;

/** Text we are required to show alongside the imagery. */
const GOOGLE_ATTRIBUTION = "Google Maps";

// ---------------------------------------------------------------------------
// Key redaction — provider error text can embed the key-bearing tile URL
// ---------------------------------------------------------------------------

/**
 * Strip `key=` query parameters out of diagnostic text. The key is already
 * public in the built bundle (the browser talks to tile.googleapis.com
 * directly), so this is not a secrecy control — it exists so a key never lands
 * in an error message someone screenshots or pastes into a bug report.
 */
export function redactKey(text: string): string {
  return text.replace(/([?&]key=)[^&\s"']+/gi, "$1[redacted]");
}

/** Normalize any thrown value into redacted, human-readable text. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return redactKey(err.message);
  if (typeof err === "string") return redactKey(err);
  // Cesium errors can be RequestErrorEvent objects rather than Errors.
  const asRecord = err as { statusCode?: unknown };
  if (asRecord && typeof asRecord.statusCode === "number") {
    return `status ${asRecord.statusCode}`;
  }
  try {
    const s = String(err);
    return s === "[object Object]" ? "unknown error" : redactKey(s);
  } catch {
    return "unknown error";
  }
}

// ---------------------------------------------------------------------------
// Camera placement
// ---------------------------------------------------------------------------

/**
 * Position + orient the Cesium camera for a CameraView. The destination is the
 * real lat/lng and the WGS84 *ellipsoidal* height computed by the backend's
 * geometry.py — Cartesian3.fromDegrees consumes ellipsoidal heights, which is
 * exactly why the GEOID18 conversion upstream is load-bearing (~32 m otherwise).
 */
export function applyCameraView(viewer: Viewer, view: CameraView): void {
  viewer.camera.setView({
    destination: Cartesian3.fromDegrees(view.lng, view.lat, view.heightM),
    orientation: {
      heading: CesiumMath.toRadians(view.headingDeg),
      // Cesium pitch: 0 = horizon, negative = look down; same convention as
      // CameraView.pitchDeg.
      pitch: CesiumMath.toRadians(view.pitchDeg),
      roll: 0,
    },
  });
}

// ---------------------------------------------------------------------------
// Attribution compositing
// ---------------------------------------------------------------------------

/**
 * Read the aggregated data attribution for the frame Cesium just drew.
 *
 * Google's Photorealistic 3D Tiles return attribution per tile in the glTF
 * `asset.copyright` field; `showCreditsOnScreen: true` makes Cesium aggregate
 * and de-duplicate the credits for the tiles in the current frame into
 * `creditDisplay.container`. We read the aggregate rather than re-implement
 * it.
 */
export function readAttribution(viewer: Viewer): string[] {
  const container = viewer.creditDisplay?.container;
  if (!container) return [];
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
 * The attribution is baked into the pixels on purpose: an `<img>` detached
 * from the Cesium widget would otherwise carry no credit at all, and Map Tiles
 * policy requires the attribution to be displayed with the imagery. The bar is
 * the ONLY thing ever composited into an output frame.
 */
export function composeAttributedPng(
  source: HTMLCanvasElement,
  attribution: string[],
): string {
  const text =
    attribution.length > 0
      ? `${GOOGLE_ATTRIBUTION} · ${attribution.join(", ")}`
      : GOOGLE_ATTRIBUTION;

  const { fontPx } = barMetrics(source.width);
  const font = `${fontPx}px system-ui, -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif`;

  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) {
    throw new Error("2D context unavailable for attribution compositing");
  }
  measure.font = font;

  const bar = layoutAttributionBar(source.width, text, (s) =>
    measure.measureText(s).width,
  );

  const out = document.createElement("canvas");
  out.width = source.width;
  out.height = source.height + bar.heightPx;
  const ctx = out.getContext("2d");
  if (!ctx) {
    throw new Error("2D context unavailable for attribution compositing");
  }

  ctx.drawImage(source, 0, 0);
  ctx.fillStyle = "#0b0d10";
  ctx.fillRect(0, source.height, out.width, bar.heightPx);
  ctx.fillStyle = "#e8eaed";
  ctx.font = font;
  ctx.textBaseline = "top";
  bar.lines.forEach((line, i) => {
    ctx.fillText(
      line,
      bar.padPx,
      source.height + bar.padPx / 2 + i * bar.lineHeightPx,
    );
  });

  return out.toDataURL("image/png");
}

// ---------------------------------------------------------------------------
// The render session
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Google Map Tiles API key (Photorealistic 3D Tiles). Required. */
  apiKey: string;
  /**
   * Aborts the session (superseded plan, unmount, StrictMode double-invoke).
   * Without it an orphaned run keeps its WebGL context alive and streaming,
   * and two concurrent viewers end up fighting over the GPU.
   */
  signal?: AbortSignal;
  /** Per-view progress callback: fires when a view starts capturing. */
  onViewStart?: (slot: ViewSlot) => void;
}

/** The outcome of one direction. */
export type ViewOutcome =
  | { slot: ViewSlot; ok: true; result: CaptureResult }
  | { slot: ViewSlot; ok: false; detail: string };

class RenderAbortedError extends Error {
  constructor() {
    super("Tile render aborted (superseded).");
    this.name = "RenderAbortedError";
  }
}

export function isRenderAborted(err: unknown): boolean {
  return err instanceof RenderAbortedError;
}

/** Render frames for `durationMs` so the tileset can stream. */
async function pumpFrames(
  viewer: Viewer,
  durationMs: number,
  checkAborted: () => void,
): Promise<void> {
  const until = Date.now() + durationMs;
  while (Date.now() < until) {
    checkAborted();
    try {
      viewer.scene.requestRender();
      viewer.render();
    } catch {
      // A render throwing here is the capture's problem, not the warm-up's.
      return;
    }
    await new Promise<void>((r) => setTimeout(r, PUMP_INTERVAL_MS));
  }
}

/**
 * Wait until the tileset is settled for the current view, or a timeout.
 *
 * - Drives `viewer.render()` on an interval, because offscreen rAF callbacks
 *   get throttled and tile round-trips only advance inside a render.
 * - Debounces `loadProgress(0, 0)` with SETTLE_GRACE_MS, because the event
 *   fires (0,0) both at startup and briefly between refinement batches.
 * - Never accepts the initial (0,0) as settled (`seenNonZero` guard).
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

    if (signal?.aborted) {
      finish();
      return;
    }
    signal?.addEventListener("abort", finish, { once: true });

    const scheduleSettle = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(finish, SETTLE_GRACE_MS);
    };
    const cancelSettle = () => {
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
    };

    const removeLoadProgress = tileset.loadProgress.addEventListener(
      (pendingRequests: number, tilesProcessing: number) => {
        if (pendingRequests > 0 || tilesProcessing > 0) {
          seenNonZero = true;
          cancelSettle();
        } else if (seenNonZero) {
          scheduleSettle();
        }
      },
    );
    const removeAllLoaded = tileset.allTilesLoaded.addEventListener(() => {
      seenNonZero = true;
      scheduleSettle();
    });

    const hardTimer = setTimeout(finish, timeoutMs);
    const renderInterval = setInterval(() => {
      if (done) return;
      try {
        viewer.scene.requestRender();
        viewer.render();
      } catch {
        // Ignore errors from a partially-torn-down viewer.
      }
    }, PUMP_INTERVAL_MS);

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
 * Render all views in one Cesium session. Returns one outcome per view, in
 * order; calls `onViewStart` as each begins so the UI can show progress. A
 * direction that fails is retried once inside the still-open session (free),
 * then reported as failed — with no image, never a placeholder.
 *
 * Throws only for whole-session failures (bad key, no WebGL, abort): there is
 * no session in which any direction could succeed, so the caller shows the
 * honest "nothing loaded" state.
 */
export async function renderViews(
  views: CameraView[],
  opts: RenderOptions,
): Promise<ViewOutcome[]> {
  const { apiKey, signal, onViewStart } = opts;

  const checkAborted = () => {
    if (signal?.aborted) throw new RenderAbortedError();
  };
  checkAborted();

  // Hard provider guard. When no key is resolvable, Cesium's
  // createGooglePhotorealistic3DTileset silently falls back to Cesium Ion's
  // hosted copy — a different provider, account, and meter, with no signal to
  // the user. The imagery would still be real, so this is not a fabrication
  // risk, but 27B states which provider produced each frame, and an
  // undisclosed provider swap would make that statement false. Refuse loudly.
  // (Verified against cesium@1.143.0.)
  if (!apiKey || !apiKey.trim()) {
    throw new Error(
      "No Map Tiles API key supplied — refusing to render rather than falling back to a different imagery provider.",
    );
  }

  // Cesium requires *some* Ion token to boot even when we only use Google
  // tiles. Empty string disables Ion's default assets; the Google tileset is
  // loaded explicitly below with the Maps key, so no Ion asset is fetched.
  Ion.defaultAccessToken = "";

  // Offscreen host: on-DOM (WebGL needs a real canvas) but visually hidden.
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-99999px;top:0;pointer-events:none;";
  host.style.width = `${RENDER_TUNING.width}px`;
  host.style.height = `${RENDER_TUNING.height}px`;
  document.body.appendChild(host);

  let viewer: Viewer | null = null;
  let destroyed = false;
  const destroyNow = () => {
    if (destroyed) return;
    destroyed = true;
    try {
      viewer?.destroy();
    } catch {
      // Already torn down or mid-teardown.
    }
    host.remove();
    signal?.removeEventListener("abort", destroyNow);
  };
  // An abort mid-await is only caught at the next checkpoint, which can be
  // seconds away. This listener tears the WebGL context down the instant the
  // signal fires, so an orphaned run can never overlap a fresh one on the GPU.
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
      // We drive rendering explicitly, so no continuous tile streaming.
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      // No default Bing/Ion base imagery layer — only the Google mesh. This
      // also keeps any non-Google map service out of the same view, which
      // Maps Platform ToS §3.2.3(e) requires.
      baseLayer: false as unknown as ImageryLayer,
      // WebGL clears its drawing buffer after compositing unless asked not
      // to, so `canvas.toDataURL()` can come back blank/black depending on
      // when the browser composites. Readback is the whole point of this
      // module. (Verified in Chrome: without this, captures are unreliable
      // frame to frame.)
      contextOptions: { webgl: { preserveDrawingBuffer: true } },
    });

    viewer.scene.globe.show = false; // hide the default ellipsoid globe

    // FOV + near plane, set explicitly so neither drifts with Cesium defaults.
    const frustum = viewer.camera.frustum as { fov?: number; near?: number };
    if (typeof frustum.fov === "number") {
      frustum.fov = CesiumMath.toRadians(RENDER_TUNING.fovDeg);
    }
    if (typeof frustum.near === "number") frustum.near = 0.1;

    // `showCreditsOnScreen: true` is what Google's own Photorealistic 3D Tiles
    // sample sets; it surfaces the per-tile `asset.copyright` strings that we
    // read back and bake into each frame.
    //
    // We deliberately do NOT pass `onlyUsingWithGoogleGeocoder: true`: the
    // flag is a self-attestation that only silences a Cesium console warning,
    // and 27B geocodes with NYC Planning GeoSearch, so setting it would assert
    // something untrue about this app. We take the warning instead. (Checked
    // 2026-08-04: no Google document conditions 3D Tiles use on the Google
    // geocoder; ToS §3.2.3(e) restricts use with a non-Google *map*, and this
    // viewer displays no map alongside.)
    const tileset = await createGooglePhotorealistic3DTileset(
      { key: apiKey },
      { showCreditsOnScreen: true },
    );
    checkAborted(); // may have been destroyed by the listener while awaiting
    tileset.maximumScreenSpaceError = RENDER_TUNING.maximumScreenSpaceError;

    // Own tile failures: Cesium's default handler logs the failing URL, and
    // for Photorealistic 3D Tiles that URL carries `key=`. Registering any
    // listener suppresses the default.
    tileset.tileFailed.addEventListener(
      (e: { url?: string; message?: string }) => {
        console.error("[27b] tile failed:", describeError(e?.message ?? e));
      },
    );

    viewer.scene.primitives.add(tileset);

    // Warm the tileset with real pumped frames — a bare sleep loads nothing,
    // because tile discovery only advances inside Scene.render().
    if (views.length > 0) applyCameraView(viewer, views[0]);
    await pumpFrames(viewer, WARMUP_MS, checkAborted);
    checkAborted();

    const activeViewer = viewer;
    let firstCapture = true;

    const captureOnce = async (view: CameraView): Promise<ViewOutcome> => {
      checkAborted();
      applyCameraView(activeViewer, view);
      activeViewer.scene.requestRender();
      const budgetMs = firstCapture
        ? Math.round(RENDER_TUNING.settleTimeoutMs * FIRST_CAPTURE_SETTLE_FACTOR)
        : RENDER_TUNING.settleTimeoutMs;
      firstCapture = false;
      await waitForTiles(activeViewer, tileset, budgetMs, signal);
      checkAborted();

      // Give the GPU time to finish uploading textures before readback — a
      // single render() can fire before the upload queue drains.
      activeViewer.scene.requestRender();
      await new Promise<void>((r) => setTimeout(r, 800));
      activeViewer.scene.requestRender();
      await new Promise<void>((r) => setTimeout(r, 200));

      // Count the provider TRIANGLES that actually draw in the frame we are
      // about to read back. A settle can time out having loaded nothing; the
      // canvas then reads back fine and the app would present Cesium's sky
      // gradient over a black earth as this building's view — the fabricated-
      // scene failure arriving by accident. Counting tiles is not enough (a
      // selected tile can carry no payload); triangles are the thing that can
      // actually appear in a picture. This inspects our renderer's scene
      // statistics, never the image pixels.
      let trianglesDrawn = 0;
      const stopCounting = tileset.tileVisible.addEventListener((tile) => {
        trianglesDrawn += tile.content?.trianglesLength ?? 0;
      });
      try {
        // Request inside the counting window so THIS frame is certain to draw
        // — it is both the frame counted and the frame read back below.
        activeViewer.scene.requestRender();
        activeViewer.render();
      } finally {
        stopCounting();
      }

      if (trianglesDrawn === 0) {
        return {
          slot: view.slot,
          ok: false,
          detail: `No provider geometry drew for slot ${view.slot}: 0 triangles. The frame is sky only.`,
        };
      }

      // Read the attributions Google returned for the tiles in THIS frame —
      // Cesium rebuilds the credit container each frame, so this is per-view
      // data, not a constant.
      const attribution = readAttribution(activeViewer);
      const dataUrl = composeAttributedPng(activeViewer.canvas, attribution);
      return {
        slot: view.slot,
        ok: true,
        result: { slot: view.slot, dataUrl, attribution },
      };
    };

    const outcomes: ViewOutcome[] = [];
    const started = Date.now();
    for (const view of views) {
      onViewStart?.(view.slot);
      let outcome: ViewOutcome;
      try {
        outcome = await captureOnce(view);
        // One free in-session retry: an empty frame is usually a starved
        // settle, and the second pass runs against a warmer tileset.
        if (!outcome.ok) outcome = await captureOnce(view);
      } catch (err) {
        if (err instanceof RenderAbortedError) throw err;
        // A readback failure (CORS taint) is a property of the WebGL context,
        // not the direction — but it is rare and terminal either way; report
        // this direction failed and let the remaining ones state their own.
        outcome = { slot: view.slot, ok: false, detail: describeError(err) };
      }
      if (!outcome.ok) {
        console.error(`[27b] view ${view.slot} failed: ${outcome.detail}`);
      }
      outcomes.push(outcome);
    }
    console.debug(
      `[27b] session rendered ${outcomes.filter((o) => o.ok).length}/${views.length} views in ${Date.now() - started} ms (1 billable root-tileset request)`,
    );
    return outcomes;
  } finally {
    destroyNow();
  }
}
