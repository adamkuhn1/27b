// In-page driver for the rendering bake-off.
//
// Served by the Vite dev server out of the app's own root, so the `import()`
// calls below resolve to the SAME transformed modules the running app uses.
// That is the point: the bake-off drives the shipped code path with overridden
// tuning values, not a re-implementation of it that could quietly diverge.
//
// Nothing here reads a pixel of provider imagery. It records our own telemetry
// (timings, canvas size, Cesium's own settings) and hands the frames back
// unmodified for a human to look at. See the header of src/lib/confidence.ts
// for why automated analysis of the captured frames is not available to this
// project.

const mods = {};

async function load() {
  if (mods.loaded) return mods;
  mods.planView = await import("/src/pipeline/planView.ts");
  mods.geometry = await import("/src/lib/geometry.ts");
  mods.confidence = await import("/src/lib/confidence.ts");
  mods.neighbors = await import("/src/lib/neighbors.ts");
  mods.config = await import("/src/lib/config.ts");
  mods.tileRenderer = await import("/src/viewer/tileRenderer.ts");
  mods.loaded = true;
  return mods;
}

/** Geometry only: no provider request, no cost. */
export async function geometryProbe({ address, floor, offsets }) {
  const m = await load();
  // Bypass the app's plan cache so a probe always reflects live source data.
  localStorage.clear();
  const res = await m.planView.planView(address, floor);
  if (!res.ok) return { ok: false, reason: res.reason, message: res.message };

  const { plan } = res;
  const fp = plan.footprint;
  const { neighbors, incomplete } = await m.neighbors.fetchNeighbors(
    fp.centroid.lat,
    fp.centroid.lng,
    m.confidence.SEARCH_RADIUS_M,
  );

  const byOffset = offsets.map((offsetM) => {
    const { views, basis, concentration } = m.geometry.buildCameraViews(
      fp,
      plan.eyeElevationEllipsoidalM,
      plan.eyeElevationNavd88M - fp.groundElevationNavd88M,
      offsetM,
    );
    const report = m.confidence.assessConfidence({
      views,
      eyeElevationNavd88M: plan.eyeElevationNavd88M,
      subjectBin: fp.bin,
      subjectGroundElevationNavd88M: fp.groundElevationNavd88M,
      neighbors,
      neighborDataIncomplete: incomplete,
    });

    return {
      offsetM,
      basis,
      concentration,
      views: views.map((v) => {
        const conf = report.bySlot[v.slot];
        // Safety checks, all from NYC Open Data + our own arithmetic.
        const local = m.geometry.ringToLocalMeters(fp.ring, fp.centroid);
        const dirX = Math.sin((v.headingDeg * Math.PI) / 180);
        const dirY = Math.cos((v.headingDeg * Math.PI) / 180);
        const insideSubject = m.geometry.pointInRingMeters(
          local,
          v.standoffM * dirX,
          v.standoffM * dirY,
        );
        // Inside a neighbour's *mass*, not merely over its lot: the camera has
        // to be within the footprint AND below that building's roof. A camera
        // at the 8th floor above a 4-storey neighbour is over its roof, which
        // is a legitimate (and common) NYC vantage.
        let insideNeighbor = null;
        for (const n of neighbors) {
          if (n.bin === fp.bin) continue;
          const nl = m.geometry.ringToLocalMeters(n.ring, {
            lat: v.lat,
            lng: v.lng,
          });
          if (!m.geometry.pointInRingMeters(nl, 0, 0)) continue;
          const top =
            (n.groundElevationNavd88M ?? fp.groundElevationNavd88M) + n.roofHeightM;
          const record = {
            bin: n.bin,
            topNavd88M: +top.toFixed(2),
            eyeBelowTopM: +(top - plan.eyeElevationNavd88M).toFixed(2),
          };
          // Prefer to report the worst case: a neighbour whose roof is above
          // the eye means the camera is embedded in solid building.
          if (!insideNeighbor || record.eyeBelowTopM > insideNeighbor.eyeBelowTopM) {
            insideNeighbor = record;
          }
        }
        return {
          slot: v.slot,
          headingDeg: v.headingDeg,
          compass: v.compass,
          standoffM: v.standoffM,
          wallDistM: v.standoffM - offsetM,
          heightM: v.heightM,
          pitchDeg: v.pitchDeg,
          firstBlockingM: conf?.firstBlockingM ?? null,
          maxObstructionAngleDeg: conf?.maxObstructionAngleDeg ?? null,
          band: conf?.band ?? null,
          insideSubjectFootprint: insideSubject,
          insideNeighbor,
        };
      }),
    };
  });

  return {
    ok: true,
    address,
    floor,
    bin: fp.bin,
    roofHeightM: fp.roofHeightM,
    groundElevationNavd88M: fp.groundElevationNavd88M,
    ringVertices: fp.ring.length,
    eyeElevationNavd88M: plan.eyeElevationNavd88M,
    eyeElevationEllipsoidalM: plan.eyeElevationEllipsoidalM,
    geoidHeightM: plan.geoidHeightM,
    floorClampedToRoof: plan.floorClampedToRoof,
    neighborsConsidered: neighbors.length,
    neighborDataIncomplete: incomplete,
    byOffset,
  };
}

/**
 * One render session = one billable root-tileset request.
 * `slots` limits which of the four directions are captured (cost is per
 * session, so a two-direction sweep costs exactly the same as four; it is only
 * wall clock that is saved).
 */
export async function renderConfig({ address, floor, offsetM, slots, render }) {
  const m = await load();
  localStorage.clear();
  const res = await m.planView.planView(address, floor);
  if (!res.ok) return { ok: false, reason: res.reason, message: res.message };

  const { plan } = res;
  const { views } = m.geometry.buildCameraViews(
    plan.footprint,
    plan.eyeElevationEllipsoidalM,
    plan.eyeElevationNavd88M - plan.footprint.groundElevationNavd88M,
    offsetM,
  );
  const wanted = slots && slots.length ? views.filter((v) => slots.includes(v.slot)) : views;

  const key = m.config.googleMapsKey();
  if (!key) return { ok: false, reason: "no-key", message: "No imagery key configured." };

  const t0 = performance.now();
  const session = await m.tileRenderer.openRenderSession(wanted, {
    apiKey: key,
    ...render,
  });
  const openedMs = performance.now() - t0;

  const frames = [];
  const events = [];
  for await (const ev of session.events) {
    if (ev.kind === "view-captured") {
      frames.push({
        slot: ev.result.slot,
        dataUrl: ev.result.dataUrl,
        attribution: ev.result.attribution,
        settled: ev.settled,
        elapsedMs: ev.elapsedMs,
        attempt: ev.attempt,
      });
      events.push({ kind: ev.kind, slot: ev.result.slot, settled: ev.settled, elapsedMs: ev.elapsedMs });
    } else if (ev.kind === "view-failed") {
      events.push({ kind: ev.kind, slot: ev.slot, detail: ev.failure.detail, willRetry: ev.willRetry });
    } else {
      events.push({ kind: ev.kind });
    }
  }
  const totalMs = performance.now() - t0;

  // Our own render surface, measured — not a claim about the imagery.
  const canvases = Array.from(document.querySelectorAll("canvas"));
  const cv = canvases[canvases.length - 1];
  const surface = cv
    ? { canvasWidth: cv.width, canvasHeight: cv.height, cssWidth: cv.clientWidth, cssHeight: cv.clientHeight }
    : null;

  const perf = performance.memory
    ? { usedJSHeapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) }
    : null;

  // Stash the pixels separately: shipping four base64 PNGs back through one
  // CDP Runtime.evaluate result is what makes the protocol connection stall.
  window.__bakeFrames = frames.map((f) => f.dataUrl);

  return {
    ok: true,
    address,
    floor,
    offsetM,
    render,
    openedMs: Math.round(openedMs),
    totalMs: Math.round(totalMs),
    surface,
    perf,
    devicePixelRatio: window.devicePixelRatio,
    views: wanted.map((v) => ({
      slot: v.slot,
      headingDeg: v.headingDeg,
      compass: v.compass,
      standoffM: v.standoffM,
      heightM: v.heightM,
      pitchDeg: v.pitchDeg,
    })),
    frames: frames.map((f) => ({
      slot: f.slot,
      attribution: f.attribution,
      settled: f.settled,
      elapsedMs: Math.round(f.elapsedMs),
      attempt: f.attempt,
      bytes: f.dataUrl.length,
    })),
    events,
  };
}

/** One frame's data URL at a time, so no single CDP response is enormous. */
export function takeFrame(i) {
  return (window.__bakeFrames && window.__bakeFrames[i]) || null;
}

/**
 * Cesium's own defaults, read from a bare Viewer with no tileset attached.
 * No tileset means no root-tileset request, so this probe is free. It exists so
 * the report can state what the app inherited rather than what the docs say.
 */
export async function cesiumDefaults() {
  const C = await import("cesium");
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-99999px;top:0;width:800px;height:600px;";
  document.body.appendChild(host);
  const v = new C.Viewer(host, {
    baseLayerPicker: false, geocoder: false, homeButton: false,
    sceneModePicker: false, navigationHelpButton: false, animation: false,
    timeline: false, fullscreenButton: false, selectionIndicator: false,
    infoBox: false, requestRenderMode: true, maximumRenderTimeChange: Infinity,
    baseLayer: false,
  });
  const f = v.camera.frustum;
  const out = {
    cesiumVersion: C.VERSION,
    frustum: {
      fovDeg: +C.Math.toDegrees(f.fov).toFixed(3),
      fovyDeg: +C.Math.toDegrees(f.fovy).toFixed(3),
      near: f.near,
      far: f.far,
      aspectRatio: +f.aspectRatio.toFixed(4),
    },
    viewer: {
      useBrowserRecommendedResolution: v.useBrowserRecommendedResolution,
      resolutionScale: v.resolutionScale,
    },
    scene: {
      msaaSamples: v.scene.msaaSamples,
      fxaaEnabled: v.scene.postProcessStages?.fxaa?.enabled ?? null,
    },
    canvas: { width: v.canvas.width, height: v.canvas.height },
    devicePixelRatio: window.devicePixelRatio,
  };
  v.destroy();
  host.remove();
  return out;
}

/** WebGL backend identification — proves whether the capture had a real GPU. */
export function gpuInfo() {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2") || c.getContext("webgl");
  if (!gl) return { webgl: false };
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    webgl: true,
    version: gl.getParameter(gl.VERSION),
    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
  };
}
