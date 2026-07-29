# 27B

Type a New York City address and a floor. 27B places a virtual camera at the
building's **real** coordinates and floor height inside Google's photorealistic
3D reconstruction of the city, then looks out in each cardinal direction (N/E/S/W)
to show, **approximately, what you'd see** from that window.

The name is the joke: 27B is the apartment you can't afford, and now you can at
least look out its windows.

---

## Run it

```bash
# from the monorepo root (workspaces are hoisted)
npm install

# dev server (port 5174)
npm run dev -w @portfolio-suite/27b

# unit tests (geometry / validation / pipeline / metrics)
npm run test -w @portfolio-suite/27b

# typecheck + production build
npm run typecheck -w @portfolio-suite/27b
npm run build -w @portfolio-suite/27b
```

Everything **except the final 3D render** works with no API key: geocoding,
building/height lookup, elevation + heading math, caching, metrics, and the full
UI (including the honest "not available" and "imagery not configured" states).

### The one key you need (for Adam)

The renderer is gated behind a single env var:

```bash
cp apps/27b/.env.example apps/27b/.env.local
# then set:
VITE_GOOGLE_MAPS_KEY=<your key>
```

Get a key at [console.cloud.google.com](https://console.cloud.google.com/) →
**APIs & Services → Credentials**, then **enable the "Map Tiles API"** (this is
the SKU that serves Photorealistic 3D Tiles). Restrict the key to your deploy
origin(s). The moment the key is present, the four views render; until then the
app shows the truthful *"imagery source not configured"* state — **never** a
placeholder or simulated scene.

---

## Pipeline architecture

The pipeline is deliberately split into two halves that never blur:

```
address + floor
   │
   ├─ (1) GEOMETRY — must be real, fully keyless, unit-tested
   │      geocode ──► footprint/height ──► floor elevation ──► 4 cardinal cameras
   │      NYC GeoSearch   NYC OpenData        estimate + clamp    heading + facade offset
   │      (lat/lng+BIN)   (HEIGHTROOF/GROUNDELEV)
   │                                   └─► ViewPlan (real coords, real elevation)
   │
   └─ (2) RENDER — key-gated, the only metered step
          CesiumJS + Google Photorealistic 3D Tiles
          camera placed at each ViewPlan vantage ──► 4 static PNG captures
```

**Why this split is the whole ballgame:** the geometry half can only ever decide
*where a real camera goes*. It cannot produce a scene. The render half streams
Google's real photogrammetric mesh. So there is no code path — success, error, or
no-key — that can fabricate imagery. That is the project's hard constraint,
enforced structurally rather than by good intentions.

### Modules

| Path | Responsibility |
| --- | --- |
| `src/lib/types.ts` | Domain types; the geometry/render contract (`ViewPlan`). |
| `src/lib/validation.ts` | Client-side address + floor gate; NYC bbox. |
| `src/lib/geocode.ts` | NYC Planning **GeoSearch** (free, key-less). NYC-only by construction → doubles as the "is this NYC" authority. |
| `src/lib/footprint.ts` | NYC OpenData **Building Footprints** (Socrata, free). `HEIGHTROOF`/`GROUNDELEV`, ft→m, centroid. |
| `src/lib/geometry.ts` | Floor-elevation estimate + roof clamp, per-heading lat/lng offset, four-cardinal camera build, area-weighted polygon centroid. **The tested math.** |
| `src/lib/cache.ts` | Address-keyed plan cache + `(BIN,floor)` capture cache (localStorage). |
| `src/lib/metrics.ts` | Addresses processed, pipeline latency, cache hit rate. |
| `src/lib/config.ts` | The `VITE_GOOGLE_MAPS_KEY` gate. |
| `src/pipeline/planView.ts` | Orchestrates geocode → footprint → geometry; routes **every** failure to the honest unavailable state. Deps injectable for tests. |
| `src/viewer/cesiumCamera.ts` | `CameraView` → Cesium camera (deg→rad orientation). |
| `src/viewer/tileRenderer.ts` | **Frugal** single-session Cesium render → 4 static PNGs, then tears down. |
| `src/viewer/useTileCaptures.tsx` | Renders captures once per plan, shares via context, caches; key-gated. |
| `src/ui/*` | Form, states, four-view grid, metrics panel, save-views. |

### The floor-elevation approximation (documented on purpose)

NYC Building Footprints carry **no per-floor field**. So the eye elevation for
floor *N* is estimated:

```
eye = GROUNDELEV + (N − 1) × 3.2 m  + 1.5 m   (floor-to-floor + eye height)
      clamped so it never exceeds GROUNDELEV + HEIGHTROOF
```

3.2 m is a middle-of-road residential floor-to-floor height. The clamp means we
**refuse to place a camera above a building that isn't that tall** — a floor
above the roof is clamped to the roof and the UI flags it. This is the "height-
only vertical framing" the v1 spec calls for (no per-floor parallax), and the
reason every label says *"approximately what you'd see."*

---

## Anti-fabrication guarantees, per code path

`qa-audit` traces every path including errors. Here is each one:

| Path | What renders | Fabrication risk |
| --- | --- | --- |
| Valid NYC address, key set, tiles load | Real Google 3D-tile captures | None — real photogrammetry. |
| Valid address, **no key** | Empty labeled frames + *"imagery source not configured"* | None — no scene drawn. |
| Address not in NYC / not found | *"not available"* state | None — no scene. |
| Address found but no BIN | *"not available"* (no-footprint) | None — no scene. |
| BIN found but no height on file | *"not available"* (no-footprint) | None — no scene. |
| Upstream service down | *"not available"* (network-error) | None — no scene. |
| Tiles fail to load after key set | Per-view *"imagery didn't load"* notice | None — no scene. |
| Floor above the roof | Real render, clamped to roof + flagged | None — refuses to exceed real height. |

There is **no** procedural / block-model / placeholder scene anywhere in the
codebase. Missing real data always resolves to a truthful message.

---

## Cost-cap notes

The **only** metered resource is Google Photorealistic 3D Tiles:

- **Free to ~1,000 tile-events/month**, then ~$6/1,000 (Enterprise SKU).
- At ~4 renders/address that's **~250 free addresses/month**.

How this app stays under the cap:

1. **Render once, capture static.** `tileRenderer` spins up a single Cesium
   session, moves the camera to all four vantages, captures a PNG each, then
   destroys the viewer. No live globe streaming tiles continuously.
2. **Two-level caching.** The `ViewPlan` (geometry) is cached per
   `(address, floor)`; the four **captures** are cached per `(BIN, floor)`. A
   repeat lookup of the same building+floor renders **zero tiles** — it replays
   PNGs from localStorage. The metrics panel's cache-hit-rate is the live view of
   how well this is working.
3. **Key-gated, lazily imported.** The heavy renderer is dynamically imported
   only on the real render path; with no key it is never invoked.

> ⚠️ **First paid point — flag before crossing.** Exceeding the free
> 1,000 tile-events/month (roughly 250 uncached addresses) triggers per-event
> billing. This must be an explicit cost decision, not a silent overage.

**Deferred (not built in v1):** the optional AI-photorealism refinement pass
(FLUX.2 + depth/canny ControlNet, or Nano Banana Pro) described in
`research/synthesis.md §2`. Per Adam's decision, v1 ships the **free raw-render
path only** — no model-API calls. When enabled later, it stays structure-gated
(SSIM/depth check discards any frame that drifts geometry) so it can enhance
texture/lighting without ever relocating a building.

Free-and-unmetered: GeoSearch geocoding and NYC OpenData footprints.

---

## What's blocked on the key

Only the final render + capture. To verify locally without a key you can:

- run the full test suite (all geometry/pipeline logic),
- exercise the UI end-to-end (real geocode + footprint fetch happen keyless; the
  four frames just show the *"imagery source not configured"* state).

With a key added, the four views populate with real captures and the **Save
views** action downloads them as PNGs.
