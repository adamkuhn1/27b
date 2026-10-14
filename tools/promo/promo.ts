// Capture page for 27B's promotional video (dev only; never built or deployed).
//
// It plans views through the real API and renders them with the same camera
// placement as the app (applyCameraView), but in a visible viewer with
// Cesium's on-screen credits (Google logo and per-tile data attributions)
// left in place, so every captured frame carries them. tools/promo/capture.mjs
// drives it frame by frame and screenshots #stage.
//
// Map Tiles policy allows a promotional video of at most 30 s, marked "for
// promotional purposes only", with attribution intact. Nothing here caches
// tiles or analyses imagery; frames are written only as video source.

import {
  Cesium3DTileset,
  createGooglePhotorealistic3DTileset,
  ImageryLayer,
  Ion,
  JulianDate,
  Math as CesiumMath,
  Viewer,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { planView } from "../../src/lib/api";
import type { CameraView } from "../../src/lib/types";
import { applyCameraView, RENDER_TUNING } from "../../src/viewer/tileRenderer";

const params = new URLSearchParams(location.search);
const W = Number(params.get("w") ?? 1600);
const H = Number(params.get("h") ?? 900);

const stage = document.getElementById("stage")!;
stage.style.width = `${W}px`;
stage.style.height = `${H}px`;
const label = stage.querySelector<HTMLElement>(".label")!;

let viewer: Viewer | null = null;
let tileset: Cesium3DTileset | null = null;

function render() {
  try {
    viewer!.scene.requestRender();
    viewer!.render();
  } catch (err) {
    // A single tile texture can fail to decode; skip that frame rather than
    // letting Cesium halt rendering for the whole session.
    console.warn("[promo] render skipped:", String(err).slice(0, 120));
  }
}

/**
 * Pump frames until the tileset reports every tile for this view loaded and
 * has stayed that way for `graceMs`, or until the timeout.
 */
function settle(timeoutMs: number, graceMs = 700): Promise<{ settled: boolean; ms: number }> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    let quietSince: number | null = null;
    const tick = () => {
      render();
      const now = performance.now();
      if (tileset!.tilesLoaded) quietSince ??= now;
      else quietSince = null;
      const done = quietSince !== null && now - quietSince >= graceMs;
      if (done || now - t0 > timeoutMs) resolve({ settled: done, ms: Math.round(now - t0) });
      else setTimeout(tick, 30);
    };
    tick();
  });
}

async function boot() {
  const key = import.meta.env.VITE_GOOGLE_MAPS_KEY as string | undefined;
  if (!key) throw new Error("VITE_GOOGLE_MAPS_KEY is not set");
  Ion.defaultAccessToken = "";
  viewer = new Viewer(stage, {
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
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
    baseLayer: false as unknown as ImageryLayer,
    showRenderLoopErrors: false,
  });
  // Light the scene for a summer midday in New York, not the wall clock.
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = JulianDate.fromIso8601(params.get("time") ?? "2026-06-20T16:30:00Z");
  viewer.scene.globe.show = false;
  // Cesium places the moon for the clock time; it shows as a dark speck.
  if (viewer.scene.moon) viewer.scene.moon.show = false;
  const frustum = viewer.camera.frustum as { fov?: number; near?: number };
  frustum.fov = CesiumMath.toRadians(RENDER_TUNING.fovDeg);
  frustum.near = 0.1;
  tileset = await createGooglePhotorealistic3DTileset({ key }, { showCreditsOnScreen: true });
  tileset.maximumScreenSpaceError = Number(params.get("sse") ?? 6);
  const cacheMb = Number(params.get("cacheMb") ?? 0);
  if (cacheMb > 0) {
    tileset.cacheBytes = cacheMb * 1024 * 1024;
    tileset.maximumCacheOverflowBytes = cacheMb * 1024 * 1024;
  }
  tileset.tileFailed.addEventListener(() => console.error("[promo] tile failed"));
  viewer.scene.primitives.add(tileset);
}

let current: { name: string; where: string; views: CameraView[] } | null = null;

const promo = {
  ready: boot(),

  /** Plan an address + floor through the real API. */
  async open(name: string, address: string, floor: number) {
    await promo.ready;
    // NYC's geocoder and Open Data occasionally drop a request; retry those.
    let r = await planView(address, floor);
    for (let i = 0; i < 3 && !r.ok && r.reason === "network-error"; i++) {
      await new Promise((res) => setTimeout(res, 2000));
      r = await planView(address, floor);
    }
    if (!r.ok) throw new Error(`plan failed: ${r.reason}`);
    current = { name, where: `${address} · floor ${floor}`, views: r.plan.views };
    return r.plan.views.map((v) => ({ slot: v.slot, headingDeg: v.headingDeg, compass: v.compass }));
  },

  /** Aim view `slot` with a heading offset, then wait for tiles. */
  async aim(slot: CameraView["slot"], offsetDeg: number, timeoutMs = 6000, graceMs = 700) {
    const v = current!.views.find((x) => x.slot === slot)!;
    const heading = (((v.headingDeg + offsetDeg) % 360) + 360) % 360;
    applyCameraView(viewer!, { ...v, headingDeg: heading });
    return settle(timeoutMs, graceMs);
  },

  /** Tileset loading statistics, for tuning the settle check. */
  stats() {
    const t = tileset as unknown as {
      tilesLoaded: boolean;
      totalMemoryUsageInBytes: number;
      cacheBytes: number;
      _statistics: { numberOfPendingRequests: number; numberOfTilesProcessing: number; selected: number };
    };
    return {
      loaded: t.tilesLoaded,
      pending: t._statistics.numberOfPendingRequests,
      processing: t._statistics.numberOfTilesProcessing,
      selected: t._statistics.selected,
      memMb: Math.round(t.totalMemoryUsageInBytes / 1048576),
      cacheMb: Math.round(t.cacheBytes / 1048576),
    };
  },

  /** Show or hide the lower-left caption. */
  caption(on: boolean, facingDeg?: number) {
    label.hidden = !on;
    if (!on || !current) return;
    label.querySelector(".name")!.textContent = current.name;
    label.querySelector(".where")!.textContent = current.where;
    label.querySelector(".facing")!.textContent =
      facingDeg === undefined ? "" : `Facing ${Math.round(facingDeg)}°`;
  },
};

(window as unknown as { promo: typeof promo }).promo = promo;
