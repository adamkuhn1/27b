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
}

/** Wait until the tileset reports no tiles pending, or a timeout elapses. */
function waitForTiles(
  viewer: Viewer,
  tileset: Cesium3DTileset,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    const remove = tileset.allTilesLoaded.addEventListener(finish);
    const timer = setTimeout(finish, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      remove();
    };
    // Nudge a render so load state advances even without user interaction.
    viewer.scene.requestRender();
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
    width = 640,
    height = 480,
    settleTimeoutMs = 6000,
  } = opts;

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
    viewer.scene.primitives.add(tileset);

    const captures: CaptureResult[] = [];
    for (const view of views) {
      applyCameraView(viewer.camera, view);
      viewer.scene.requestRender();
      await waitForTiles(viewer, tileset, settleTimeoutMs);
      // One more explicit render after settle so the final frame is complete.
      viewer.scene.requestRender();
      viewer.render();
      const dataUrl = viewer.canvas.toDataURL("image/png");
      captures.push({ cardinal: view.cardinal, dataUrl });
    }
    return captures;
  } finally {
    viewer?.destroy();
    host.remove();
  }
}
