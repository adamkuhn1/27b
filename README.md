# 27B

Type a New York City address and a floor. 27B places a virtual camera at the
building's **real** coordinates and floor height inside Google's photorealistic
3D reconstruction of the city, then looks out along each of the building's four
facades to show, **approximately, what you'd see** from that window.

The name is the joke: 27B is the apartment you can't afford, and now you can at
least look out its windows.

---

## Run it

```bash
# from the monorepo root (workspaces are hoisted)
npm install

# dev server (port 5174)
npm run dev -w @portfolio-suite/27b

# unit tests (geometry / geoid / address matching / pipeline / metrics)
npm run test -w @portfolio-suite/27b

# typecheck + production build
npm run typecheck -w @portfolio-suite/27b
npm run build -w @portfolio-suite/27b
```

Everything **except the final 3D render** works with no API key: geocoding,
address verification, building/height lookup, elevation + heading math, the
geometry cache, metrics, and the full UI (including the honest "not available"
and "imagery not configured" states).

### The one key you need

The renderer is gated behind a single env var:

```bash
cp apps/27b/.env.example apps/27b/.env.local
# then set:
VITE_GOOGLE_MAPS_KEY=<your key>
```

Get a key at [console.cloud.google.com](https://console.cloud.google.com/) →
**APIs & Services → Credentials**, then **enable the "Map Tiles API"** (this is
the SKU that serves Photorealistic 3D Tiles; the API requires billing to be
enabled on the project). Restrict the key to your deploy origin(s). The moment
the key is present, the four views render; until then the app shows the truthful
*"imagery source not configured"* state — **never** a placeholder or simulated
scene.

---

## Pipeline architecture

The pipeline is deliberately split into two halves that never blur:

```
address + floor
   │
   ├─ (1) GEOMETRY — must be real, fully keyless, unit-tested
   │      geocode ──► verify match ──► footprint/height ──► floor elevation ──► 4 facade cameras
   │      NYC GeoSearch  addressMatch    NYC OpenData        NAVD88 → WGS84      footprint axis +
   │      (lat/lng+BIN)  (anti-fuzzy)    (HEIGHTROOF/        via GEOID18         outermost-wall raycast
   │                                      GROUNDELEV)
   │                                   └─► ViewPlan (real coords, real elevation, real bearings)
   │
   └─ (2) RENDER — key-gated, the only metered step
          CesiumJS + Google Photorealistic 3D Tiles
          camera placed at each ViewPlan vantage ──► 4 static PNGs + Google attribution
```

**Why this split is the whole ballgame:** the geometry half can only ever decide
*where a real camera goes*. It cannot produce a scene. The render half streams
Google's real photogrammetric mesh. So there is no code path — success, error, or
no-key — that can fabricate imagery.

### Modules

| Path | Responsibility |
| --- | --- |
| `src/lib/types.ts` | Domain types; the geometry/render contract (`ViewPlan`). |
| `src/lib/validation.ts` | Client-side address + floor gate; NYC bbox. Allows hyphenated Queens house numbers. |
| `src/lib/geocode.ts` | NYC Planning **GeoSearch** (free, key-less). |
| `src/lib/addressMatch.ts` | **Verifies the geocoder found the address you typed.** Pelias always answers with *something*; this refuses fuzzy substitutions. |
| `src/lib/footprint.ts` | NYC OpenData **Building Footprints** (Socrata, free). `HEIGHTROOF`/`GROUNDELEV` (NAVD88 ft → m), centroid, ring. |
| `src/lib/geoid.ts` | **NAVD88 → WGS84 ellipsoidal height** via a baked GEOID18 lattice (NOAA NGS). Worth ~-31.8 m in NYC. |
| `src/lib/geometry.ts` | Floor elevation + roof clamp, dominant facade axis, outermost-wall raycast, camera placement (verified outside the footprint). **The tested math.** |
| `src/lib/cache.ts` | Geometry-only cache (localStorage). Rendered imagery is deliberately never cached — see below. |
| `src/lib/metrics.ts` | Addresses processed, geometry latency, cache hit rate. |
| `src/lib/config.ts` | The `VITE_GOOGLE_MAPS_KEY` gate. |
| `src/pipeline/planView.ts` | Orchestrates geocode → footprint → geometry; routes **every** failure to the honest unavailable state. Deps injectable for tests. |
| `src/viewer/cesiumCamera.ts` | `CameraView` → Cesium camera (deg→rad orientation). |
| `src/viewer/tileRenderer.ts` | Single-session Cesium render → 4 static PNGs with attribution composited in, then tears down. |
| `src/viewer/useTileCaptures.tsx` | Renders captures once per plan and shares via context; key-gated; in-memory only. |
| `src/ui/*` | Form, states, four-view grid, attribution line, metrics panel. |
| `proof/*` | Browser harnesses that prove the happy path and the failure paths against the live services. |

### Why the four views are not N/E/S/W

Manhattan's street grid is rotated about 29° from true north, so a window in a
Manhattan building essentially never faces true north. `geometry.ts` derives the
building's dominant rectilinear orientation from its own footprint edges
(length-weighted circular mean of `exp(i·4θ)`, which is invariant under the
90° symmetry of a rectangular building) and aims the four cameras along that
axis. Each view is labelled with its **real compass bearing** (e.g. "NNE · 29°
true"), so nothing is implied that the data doesn't support.

If a footprint has no dominant orientation (round or highly irregular, measured
by the concentration of that mean), the app falls back to true N/E/S/W **and
says so in the UI** rather than inventing facades.

Cameras are placed by ray-casting from the footprint centroid to the
**outermost** boundary crossing along each bearing, then pushing 6 m past it, and
the result is verified to be outside the footprint polygon. The outermost
crossing matters for C-, U- and L-shaped buildings, where the nearest crossing is
an inner notch wall and a camera placed past it would be inside the building.

### The floor-elevation approximation (documented on purpose)

NYC Building Footprints carry **no per-floor field**. So the eye elevation for
floor *N* is estimated:

```
eye_NAVD88 = GROUNDELEV + (N − 1) × 3.2 m + 1.5 m   (floor-to-floor + eye height)
             clamped so it never exceeds GROUNDELEV + HEIGHTROOF
eye_WGS84  = eye_NAVD88 + GEOID18(lat, lng)          (≈ −31.8 m in NYC)
```

3.2 m is a middle-of-road residential floor-to-floor height. The clamp means we
**refuse to place a camera above a building that isn't that tall**. The datum
conversion is not cosmetic: NYC publishes orthometric heights and Cesium/3D
Tiles consume ellipsoidal ones, so skipping it puts the camera ~32 m — about ten
floors — too high.

---

## Anti-fabrication guarantees, per code path

Verified in a real browser by `proof/run-failure-paths.mjs` (see
`proof/evidence/failure-paths.json`):

| Path | What renders | Tile requests | Fabrication risk |
| --- | --- | --- | --- |
| Valid NYC address, key set, tiles load | Real Google 3D-tile captures + attribution | 1 root tileset | None — real photogrammetry. |
| Valid address, **no key** | Empty labeled frames + *"imagery source not configured"* | 0 | None — no scene drawn. |
| Address in another city/state | *"Address isn't in New York City"* | 0 | None — no scene. |
| Address the geocoder can only fuzzy-match | *"We couldn't find that exact address"* | 0 | None, and no wrong building either. |
| Address found but no BIN / no height on file | *"not available"* (no-footprint) | 0 | None — no scene. |
| Upstream service down | *"not available"* (network-error) | 0 | None — no scene. |
| Tiles fail to load after key set | Per-view *"imagery didn't load"* notice | — | None — no scene. |
| Floor above the roof | Real render, clamped to roof + flagged | 1 root tileset | None — refuses to exceed real height. |

There is **no** procedural / block-model / placeholder scene anywhere in the
codebase. Missing real data always resolves to a truthful message.

---

## Licence, attribution and caching

Verified against the current Google documentation on **2026-08-04**:

- **Attribution.** The Map Tiles API policies require the Google Maps logo (or,
  where space is limited, the words "Google Maps") plus the aggregated per-tile
  data attributions, displayed with the imagery. Cesium is configured with
  `showCreditsOnScreen: true`; the credits it aggregates are read back per frame
  and **composited into the bottom of each captured PNG**, and also shown as
  text under the grid. A `<img src="data:...">` detached from the Cesium widget
  would otherwise carry no credit at all.
  <https://developers.google.com/maps/documentation/tile/policies>
- **Caching.** Google Maps Platform ToS §3.2.3(b): "Customer will not cache
  Google Maps Content except as expressly permitted under the Maps Service
  Specific Terms." Those terms contain **no Map Tiles API section**, so no
  allowance exists; the policies page separately prohibits "Offline uses". So
  27B caches *geometry* only. Rendered frames live in React state for the life
  of the tab. An earlier build persisted captures to localStorage and offered a
  PNG download — both were removed as licence violations, and the app now purges
  the retired `27b:captures:*` keys on startup.
- **No AI pass on this imagery.** The Map Tiles API policies restrict the API to
  visualization and specifically exclude "Image analysis" and "Machine
  interpretation"; ToS §3.2.3(c) separately prohibits creating content from
  Google Maps Content. The depth/ControlNet photorealism pass sketched in
  `research/27b-imagery.md` is therefore **not permissible on Google 3D-tile
  output** and is not built.

## Cost

The **only** metered resource is Google Photorealistic 3D Tiles:

- The billable unit is the **root tileset request**, not individual tiles:
  "Every tile request (2D Tiles, Street View Tiles, and root tile requests for
  Photorealistic 3D Tiles) counts against your project's daily quota… Tile
  requests for Photorealistic 3D Tiles don't impact your daily quota", and "a
  single root tileset request" covers up to three hours of renderer tile
  requests.
  <https://developers.google.com/maps/documentation/tile/usage-and-billing>
- SKU `Map Tiles API: Photorealistic 3D Tiles` (C6E1-98B2-DBD0): **1,000 free
  requests/month**, then **$6.00 per 1,000**.
  <https://developers.google.com/maps/billing-and-pricing/pricing>

27B opens exactly **one** session per (address, floor) render and captures all
four views inside it, so one lookup = one billable request ≈ **1,000 free
lookups/month**, then $0.006 each. Measured on 2026-08-04: a four-view render at
350 5th Ave made 1 root-tileset request and 3,600–5,300 (unmetered) renderer tile
requests, and took 45–70 s wall clock.

> ⚠️ **First paid point — flag before crossing.** Exceeding 1,000 renders/month
> triggers per-request billing. That must be an explicit cost decision.

Free-and-unmetered: GeoSearch geocoding, NYC OpenData footprints, and the baked
GEOID18 lattice (no runtime NOAA dependency).

---

## Proof harnesses

```bash
# happy path: one address, two floors, four facade views, real tiles
npm run dev -w @portfolio-suite/27b
mkdir -p /tmp/pw && (cd /tmp/pw && npm i playwright)
NODE_PATH=/tmp/pw/node_modules node apps/27b/proof/run-proof.mjs

# failure paths: non-NYC, unresolvable address, no key (0 tile requests)
NODE_PATH=/tmp/pw/node_modules node apps/27b/proof/run-failure-paths.mjs
```

`proof/evidence/summary.json` and `proof/evidence/failure-paths.json` are
committed. The **screenshots and frame PNGs are not** — they contain Google Maps
Content, and §3.2.3(a)/(b) say not to store or re-share it. They stay on the
machine that produced them.
