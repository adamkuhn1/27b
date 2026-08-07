// Frugal 3D-tile renderer: capture four static frames from ONE Cesium session,
// and hand each one over the moment it exists.
//
// Cost discipline (see README "Cost-cap notes"): Google Photorealistic 3D Tiles
// is the only metered resource (~1,000 tile-events/mo free). A live, always-on
// globe would stream tiles continuously. Instead we spin up a single offscreen
// Cesium viewer, load the Google tileset ONCE, move the camera to each of the
// four facade vantages, wait for tiles to settle, capture a static PNG per
// view, then tear the viewer down. Four still captures per address, then the
// viewer is gone — no ongoing tile traffic.
//
// The billable unit is the **session** (one root tileset request), not the
// frame: "Timed session tokens allow for up to three hours of renderer tile
// requests from a single root tileset request", and "Tile requests for
// Photorealistic 3D Tiles don't impact your daily quota" (Map Tiles usage &
// billing, re-read 2026-08-05). So a re-capture of one direction inside a
// still-open session is free, and a re-capture after teardown costs exactly as
// much as re-rendering all four. That asymmetry is why the UI offers a
// per-direction retry only while the session is open, and a whole-result
// re-render afterwards.
//
// This module owns Cesium. It does NOT own what happens when a capture fails —
// that policy lives in renderSession.ts, where it can be tested without a
// WebGL context, a key, or a provider request.
//
// The captures are NOT cached anywhere. Google Maps Platform ToS §3.2.3(b)
// forbids caching Google Maps Content except where the Maps Service Specific
// Terms allow it, and those terms enumerate 21 services with no Map Tiles entry
// at all (re-verified 2026-08-04 against the document last modified
// 2026-06-10). So a repeat lookup of the same address is a new render and a new
// billable root-tileset request; that is the licence-correct trade, not an
// oversight. See docs/BILLING_AND_QUOTA.md.
//
// This module is only ever imported behind the key gate; it is never on the
// no-key code path, so a missing key can't reach real tile calls.

import {
  Viewer,
  Cesium3DTileset,
  createGooglePhotorealistic3DTileset,
  Ion,
  ImageryLayer,
  Math as CesiumMath,
} from "cesium";
// Imported here, not in index.html, so it travels in this lazily-imported
// chunk. Cesium's widget stylesheet is only meaningful once a `Viewer` exists;
// vite-plugin-cesium's default is to inject it as a render-blocking <head>
// link on every page load, which a visitor who never runs a lookup should not
// pay for. See the `lazyCesium` comment in vite.config.ts.
import "cesium/Build/Cesium/Widgets/widgets.css";
import type { CameraView, RenderSession } from "../lib/types";
import { applyCameraView } from "./cesiumCamera";
import { describeError } from "../lib/redact";
import {
  CaptureFailedError,
  createRenderSession,
  type FrameSource,
  type RenderSessionOptions,
} from "./renderSession";

/** Text we are required to show alongside the imagery (policy: logo or the words). */
const GOOGLE_ATTRIBUTION = "Google Maps";

/**
 * The renderer's tuning surface, in one place.
 *
 * Every number here was chosen against real captures in the rendering bake-off
 * recorded in `docs/repair/portfolio-suite-product-sprint/27b/REPORT.md`. They
 * are grouped so that a reader can see the whole set at once, and so that the
 * bake-off harness can override exactly these values and nothing else — the
 * experiment therefore drives the shipped code path rather than a copy of it.
 */
export const RENDER_TUNING = {
  /** Capture size in CSS pixels (see `superSample` for the backing store). */
  width: 800,
  height: 600,
  /**
   * Cesium renders at CSS resolution by default
   * (`Viewer.useBrowserRecommendedResolution` defaults to `true`, which
   * *ignores* devicePixelRatio), so the capture was previously 800x600 real
   * pixels no matter what display it ran on. `resolutionScale` multiplies the
   * canvas backing store, and `canvas.toDataURL()` reads the backing store —
   * so this is ordinary supersampling of our own render surface, downsampled by
   * the browser at display size. It adds raster resolution; it cannot and does
   * not add scene content.
   */
  superSample: 1,
  /** Max ms to wait for tiles to settle per view before capturing anyway. */
  settleTimeoutMs: 16000,
  /** Cesium's LOD threshold. Lower = finer tiles, more requests, more memory. */
  maximumScreenSpaceError: 10,
  /**
   * Horizontal field of view, degrees. Cesium's `PerspectiveFrustum` defaults
   * to 60 and applies `fov` to the wider viewport dimension.
   */
  fovDeg: 60,
  /**
   * Near clip plane, metres. Cesium's default is 1.0 m, which clips anything
   * closer than a metre — a real constraint once the camera sits close to a
   * facade.
   */
  nearPlaneM: 1.0,
  /**
   * Whether to apply the loading options that suit a stationary capture rather
   * than an interactive globe. See the call site for what they are and why
   * Cesium's defaults are the wrong ones here.
   */
  stationaryLoading: false,
} as const;

export interface RenderOptions {
  /** Google Map Tiles API key (Photorealistic 3D Tiles). Required. */
  apiKey: string;
  /** Capture size in CSS pixels. Small keeps memory + capture cost down. */
  width?: number;
  height?: number;
  /** Supersampling factor for the canvas backing store. See `RENDER_TUNING`. */
  superSample?: number;
  /** Max ms to wait for tiles to settle per view before capturing anyway. */
  settleTimeoutMs?: number;
  /** Cesium `Cesium3DTileset.maximumScreenSpaceError`. See `RENDER_TUNING`. */
  maximumScreenSpaceError?: number;
  /** Horizontal field of view in degrees. See `RENDER_TUNING`. */
  fovDeg?: number;
  /** Near clip plane in metres. See `RENDER_TUNING`. */
  nearPlaneM?: number;
  /** Stationary-capture tile loading options. See `RENDER_TUNING`. */
  stationaryLoading?: boolean;
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
 * Quiet period after tile activity reaches zero before a capture is called
 * settled. Long enough not to cut off the next refinement burst, short enough
 * that a genuinely finished view is not held back.
 */
const SETTLE_GRACE_MS = 900;

/** How `waitForTiles` ended. */
export interface SettleOutcome {
  /**
   * True when tile activity went quiet and the settle grace elapsed; false
   * when the hard timeout fired first, or the caller aborted.
   *
   * This distinction used to be discarded — both terminators resolved the same
   * void promise — which meant the app could not tell "this capture finished
   * refining" from "we gave up waiting after 16 s". It is the only honest basis
   * for the "still sharpening" note, and it is a statement about **our own
   * render loop**, not about the picture. See lib/confidence.ts on why the
   * distinction between those two matters here.
   */
  settled: boolean;
  waitedMs: number;
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
 *    the renderer refines the LOD. A `SETTLE_GRACE_MS` grace period after
 *    seeing (0,0) lets the second wave of detail tiles start before we declare
 *    done.
 *
 * 3. seenNonZero guard — never accept the initial (0,0) firing as "settled".
 */
function waitForTiles(
  viewer: Viewer,
  tileset: Cesium3DTileset,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SettleOutcome> {
  return new Promise((resolve) => {
    let done = false;
    let seenNonZero = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();

    const finish = (settled: boolean) => {
      if (done) return;
      done = true;
      cleanup();
      resolve({ settled, waitedMs: Date.now() - startedAt });
    };
    const finishUnsettled = () => finish(false);

    if (signal) {
      if (signal.aborted) {
        finish(false);
        return;
      }
      signal.addEventListener("abort", finishUnsettled, { once: true });
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
      settleTimer = setTimeout(() => finish(true), SETTLE_GRACE_MS);
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

    const hardTimer = setTimeout(finishUnsettled, timeoutMs);

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
      signal?.removeEventListener("abort", finishUnsettled);
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
 * Boot one Cesium session and hand back a `FrameSource` that captures a single
 * view per call.
 *
 * Everything expensive happens here, once: the WebGL context, the root tileset
 * request (**the billable unit** — one per session, regardless of how many
 * frames or retries follow), and the 3 s warm-up. `capture()` afterwards only
 * moves the camera and waits.
 *
 * Rejects if the session cannot be established at all (bad key, 403, no WebGL).
 * That is a whole-result failure and the caller renders the honest "nothing
 * loaded" state; it never becomes a per-direction failure, because there is no
 * session in which to retry a direction.
 */
async function openCesiumFrameSource(
  views: CameraView[],
  opts: RenderOptions,
): Promise<FrameSource> {
  const {
    apiKey,
    width = RENDER_TUNING.width,
    height = RENDER_TUNING.height,
    superSample = RENDER_TUNING.superSample,
    // 9 s was measured to be too short: the last view of a four-view run was
    // still at a coarse LOD when it was captured, which reads as "blocky" —
    // exactly the impression this project must never give, even though the
    // geometry is real photogrammetry throughout. Renderer tile requests inside
    // an open session are unmetered, so the only cost of waiting longer is
    // wall-clock time.
    settleTimeoutMs = RENDER_TUNING.settleTimeoutMs,
    maximumScreenSpaceError = RENDER_TUNING.maximumScreenSpaceError,
    fovDeg = RENDER_TUNING.fovDeg,
    nearPlaneM = RENDER_TUNING.nearPlaneM,
    stationaryLoading = RENDER_TUNING.stationaryLoading,
    signal,
  } = opts;

  const checkAborted = () => {
    if (signal?.aborted) throw new RenderAbortedError();
  };
  checkAborted();

  // Hard provider guard. Cesium's createGooglePhotorealistic3DTileset does this
  // when no key is resolvable:
  //
  //     const key = apiOptions.key ?? GoogleMaps.defaultApiKey;
  //     if (!defined(key)) return requestCachedIonTileset(tilesetOptions);
  //
  // i.e. it silently switches to Cesium Ion's hosted copy — a different
  // provider, a different account, and a different meter, with no signal to the
  // user. The imagery would still be real, so this is not a fabrication risk,
  // but 27B states on screen which provider produced each frame, and an
  // undisclosed provider swap would make that statement false. The app already
  // gates on a present key (useTileCaptures.tsx), so this is belt-and-suspenders
  // against a future caller: refuse loudly rather than change provider quietly.
  // Verified against cesium@1.143.0.
  if (!apiKey || !apiKey.trim()) {
    throw new Error(
      "No Map Tiles API key supplied — refusing to render rather than falling back to a different imagery provider.",
    );
  }

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
    host.remove();
    signal?.removeEventListener("abort", destroyNow);
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

    // Render the backing store larger than the CSS box and let the browser
    // downsample on display. Cesium ignores devicePixelRatio by default
    // (`useBrowserRecommendedResolution`), so without this the capture is
    // exactly `width x height` real pixels regardless of the display. This is
    // supersampling of our own render surface, nothing more: it changes how
    // finely the provider's mesh is rasterised, never what the mesh contains.
    viewer.useBrowserRecommendedResolution = true; // ignore DPR; be explicit
    viewer.resolutionScale = superSample;

    // Projection. Cesium's defaults are fov 60 deg on the wider axis and a
    // 1 m near plane; both are stated explicitly here because both are part of
    // what the capture looks like and neither should drift silently.
    const frustum = viewer.camera.frustum as { fov?: number; near?: number };
    if (typeof frustum.fov === "number") {
      frustum.fov = CesiumMath.toRadians(fovDeg);
    }
    if (typeof frustum.near === "number") {
      frustum.near = nearPlaneM;
    }

    // `showCreditsOnScreen: true` is what Google's own Photorealistic 3D Tiles
    // sample sets, and the docs require "a 3D Tiles renderer that supports the
    // display of copyright attribution". It makes Cesium surface the per-tile
    // `asset.copyright` strings; we read them back below and composite them
    // into the frame so the attribution can never be separated from the pixels.
    // https://developers.google.com/maps/documentation/tile/3d-tiles
    // https://developers.google.com/maps/documentation/tile/policies
    //
    // We deliberately do NOT pass `onlyUsingWithGoogleGeocoder: true`.
    //
    // Cesium emits a one-time console warning ("Only the Google geocoder can be
    // used with Google Photorealistic 3D Tiles") unless that flag is set. The
    // flag is a self-attestation, not a switch: it changes nothing except
    // whether the warning prints. 27B geocodes with NYC Planning GeoSearch, so
    // setting it to `true` would be asserting something untrue about this app
    // in order to silence a message. We take the warning instead.
    //
    // Re-checked 2026-08-04 for any Google-side basis for the restriction, and
    // found none in: Photorealistic 3D Tiles (updated 2026-07-31), 3D Tiles
    // overview (2026-07-31), "Work with a 3D Tiles renderer" (2026-07-31), Map
    // Tiles API Policies (2026-07-31), Maps Platform ToS (last modified
    // 2026-06-23 — zero occurrences of "geocoder"), Maps Service Specific Terms
    // (last modified 2026-06-10 — zero occurrences of "geocoder", and no Map
    // Tiles section at all). ToS §3.2.3(e) restricts use with a non-Google
    // *Map*, not a non-Google geocoder; this viewer disables the base imagery
    // layer and the globe, so no map of any kind is displayed alongside.
    //
    // This is a recorded absence of evidence, not a legal opinion, and not a
    // claim that the restriction does not exist. See README "The Cesium
    // 'Google geocoder only' warning" for the residual-risk position.
    const tileset = await createGooglePhotorealistic3DTileset(
      { key: apiKey },
      { showCreditsOnScreen: true },
    );
    checkAborted(); // may have been destroyed by the listener while awaiting
    // Lower the LOD error threshold below Cesium's default (16) to load
    // building-level detail from mid-altitude. 4 was measured to be far too
    // aggressive: one address blew past 11,000 tile requests and took ~4
    // minutes to settle. See RENDER_TUNING for the selected value.
    tileset.maximumScreenSpaceError = maximumScreenSpaceError;

    // Two Cesium defaults that exist to make a *moving* camera feel responsive
    // and that are simply wrong for a stationary still capture:
    //
    //   foveatedScreenSpaceError (default true) deliberately raises the screen
    //   space error for tiles away from the centre of the screen. In an
    //   interactive globe that is a good trade. In a framed photograph it means
    //   the edges of every capture are permanently coarser than the middle.
    //
    //   progressiveResolutionHeightFraction (default 0.3) asks for a
    //   deliberately low-resolution pass first so something appears quickly.
    //   We are not showing the intermediate frames to anyone, so it only adds
    //   requests we then throw away.
    //
    // Neither changes the finest level available; they change which tiles get
    // asked for and when. Turning both off costs nothing but wall clock.
    tileset.foveatedScreenSpaceError = !stationaryLoading;
    tileset.progressiveResolutionHeightFraction = stationaryLoading ? 0.0 : 0.3;
    viewer.scene.primitives.add(tileset);

    // Position the camera at the first view before warmup so the warm-up
    // period streams tiles for the actual vantage, not a default globe position.
    if (views.length > 0) applyCameraView(viewer.camera, views[0]);

    // Allow tiles to begin streaming.
    viewer.scene.requestRender();
    await new Promise<void>((r) => setTimeout(r, 3000));
    checkAborted();

    const activeViewer = viewer;
    return {
      async capture(view) {
        checkAborted();
        if (destroyed) throw new RenderAbortedError();

        applyCameraView(activeViewer.camera, view);
        activeViewer.scene.requestRender();
        const { settled } = await waitForTiles(
          activeViewer,
          tileset,
          settleTimeoutMs,
          signal,
        );
        checkAborted();

        // After tiles are settled, give the GPU time to finish uploading
        // textures before reading back the canvas — a single render() call may
        // fire before the texture upload queue drains. Two render + 1 s gives
        // textures time.
        activeViewer.scene.requestRender();
        await new Promise<void>((r) => setTimeout(r, 800));
        activeViewer.scene.requestRender();
        await new Promise<void>((r) => setTimeout(r, 200));
        activeViewer.render();

        // Read the attributions Google returned for the tiles in THIS frame.
        // Cesium rebuilds the credit container each frame from the tiles it
        // just drew, so this is per-view data, not a constant.
        const attribution = readAttribution(activeViewer);

        let dataUrl: string;
        try {
          dataUrl = composeAttributedPng(activeViewer.canvas, attribution);
        } catch (err) {
          // SecurityError: WebGL canvas tainted by cross-origin tile textures.
          // Google Photorealistic 3D Tiles must be served with ACAO headers for
          // readback to work. If this fires, verify that tile responses include
          // Access-Control-Allow-Origin (check DevTools Network → tile request
          // → Response Headers). A CORS proxy is required if headers are absent.
          //
          // Marked fatal for the session on purpose: the taint is a property of
          // the WebGL context, not of this direction, so every remaining view
          // would fail identically 16 s at a time. Before this was modelled,
          // the throw escaped the whole four-view function and destroyed the
          // frames that had *already succeeded*.
          throw new CaptureFailedError({
            kind: "readback-blocked",
            detail: `Canvas readback blocked (CORS taint): ${describeError(err)}`,
            fatalForSession: true,
          });
        }

        return {
          result: { slot: view.slot, dataUrl, attribution },
          settled,
        };
      },
      close: destroyNow,
    } satisfies FrameSource;
  } catch (err) {
    // Setup failed — tear the context down here, since no session will exist
    // to close it.
    destroyNow();
    throw err;
  }
}

/**
 * Open a streaming render session for a plan's four views.
 *
 * The session yields each finished frame the moment it exists rather than
 * holding all four until the last one lands. See `renderSession.ts` for the
 * event contract and the retry policy; this function is only the wiring.
 */
export async function openRenderSession(
  views: CameraView[],
  opts: RenderOptions & RenderSessionOptions,
): Promise<RenderSession> {
  const source = await openCesiumFrameSource(views, opts);
  return createRenderSession(views, source, opts);
}
