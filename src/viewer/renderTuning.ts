// The tile renderer's tuning surface, in one place and with no dependencies.
//
// This lives apart from `tileRenderer.ts` on purpose. That module imports
// Cesium, and importing Cesium is the single most expensive thing this app can
// do — the whole architecture (see the `lazyCesium` note in vite.config.ts and
// the dynamic import in useTileCaptures.tsx) exists so a visitor who never runs
// a lookup never pays for it. `lib/confidence.ts` needs one number from here and
// runs on the no-key path and in Node unit tests, so the numbers have to be
// reachable without the engine attached to them.
//
// Every value was chosen against real captures in the rendering bake-off
// recorded in `docs/repair/portfolio-suite-product-sprint/27b/REPORT.md`.
// Grouping them means a reader can see the whole set at once, and means the
// bake-off harness overrides exactly these and nothing else — so the experiment
// drives the shipped code path rather than a copy of it.

export const RENDER_TUNING = {
  /** Capture size in CSS pixels (see `superSample` for the backing store). */
  width: 800,
  height: 600,
  /**
   * Backing-store multiplier. Cesium renders at CSS resolution by default
   * (`Viewer.useBrowserRecommendedResolution` defaults to `true`, which
   * *ignores* devicePixelRatio), so the capture is `width x height` real pixels
   * no matter what display it runs on. `resolutionScale` multiplies the canvas
   * backing store and `canvas.toDataURL()` reads the backing store, so raising
   * this is ordinary supersampling of our own render surface. It adds raster
   * resolution; it cannot and does not add scene content.
   *
   * Left at 1. The bake-off measured the on-screen pane at 338 CSS px — 676
   * device pixels on a 2x display — so an 800 px capture is already finer than
   * the box it is shown in. 1.5x and 2x were captured and produce no visible
   * improvement at that size, at 2.25x and 4x the pixels and memory. Raise this
   * only alongside a layout that actually shows a frame large.
   */
  superSample: 1,
  /**
   * Max ms to wait for tiles to settle per view before capturing anyway.
   *
   * Left at 16 s. Measured across sixteen directions on four buildings, all but
   * one settled in 3.7-9.5 s; raising the ceiling to 28 s changed neither the
   * tile count nor the picture. Waiting longer is not the lever it looks like.
   */
  settleTimeoutMs: 16000,
  /**
   * Cesium's LOD threshold. Lower = finer tiles, more requests, more memory.
   *
   * Left at 10. 8 and 6 were captured: 6 costs 81% more renderer tile requests
   * and produces a frame indistinguishable from 10. At these standoffs the
   * limit is the provider's texture, not our refinement threshold.
   */
  maximumScreenSpaceError: 10,
  /**
   * Horizontal field of view, degrees. Cesium's `PerspectiveFrustum` defaults
   * to 60 and applies `fov` to the wider viewport dimension, so at a 4:3
   * capture this is the horizontal field of view exactly.
   *
   * 75 was selected in the bake-off, and it was the only one of the eleven
   * deltas tried that produced a visible improvement on more than one building.
   * At 60 a low-floor camera six metres off a Manhattan facade frames almost
   * nothing except the wall opposite, and a wall filling the frame is exactly
   * where this provider's mesh looks worst. At 75 the same capture includes the
   * roofline, the sky above it and the street below, so the frame reads as a
   * view out of a window rather than as a texture. 90 shows more again but with
   * visible wide-angle stretch at the edges.
   *
   * For scale: 75 deg horizontal on a 36 mm frame is f = 18/tan(37.5 deg) =
   * 23.5 mm, so this is a 24 mm-class wide angle — wider than the 28 mm this
   * comment used to claim. The argument for 75 is unaffected (it rests on the
   * measured captures below, not on the lens number), but 24 mm is the honest
   * comparison: it is a wide lens chosen because the subject is close, which is
   * exactly why an interior photograph of a view is usually taken with one.
   *
   * It is also the cheapest setting here: a wider frame needs less angular
   * resolution, so the same scene settles in ~26% fewer renderer tile requests
   * (measured 4,181 -> 3,060 at the Dakota, four directions).
   *
   * `confidence.CONE_HALF_ANGLE_DEG` is derived from this. Keep them in step.
   */
  fovDeg: 75,
  /**
   * Near clip plane, metres. Cesium 1.143's `PerspectiveFrustum` default is
   * **0.1 m**, not the 1.0 m its older documentation is often quoted for —
   * measured from a bare `Viewer` on 2026-08-06, alongside `far` = 1e10 and
   * `fov` = 60 deg. Stated here so the value is chosen rather than inherited,
   * and so nothing silently moves it. 1.0 was captured and changes nothing at
   * these standoffs; 0.1 is kept because it is what the app has always had.
   */
  nearPlaneM: 0.1,
  /**
   * Whether to apply tile-loading options that suit a stationary capture rather
   * than an interactive globe. See the call site in `tileRenderer.ts`.
   *
   * Left off. Both options were captured and neither changed the tile count or
   * the frame: Cesium's foveated relaxation expires 0.2 s after the camera
   * stops, and this renderer then waits seconds, so the deferred tiles load
   * anyway.
   */
  stationaryLoading: false,
} as const;
