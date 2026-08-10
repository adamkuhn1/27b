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
per-direction enclosure notes, the plan drawing, the geometry cache, metrics,
and the full UI (including the honest "not available" and "imagery not
configured" states).

One thing worth knowing before you measure anything about the bundle: with no
key set, Vite constant-folds the key gate to `false` and Rollup eliminates the
**entire** render branch, dynamic import included. A keyless production build
emits no renderer chunk at all. The gate is enforced at build time, not only at
runtime — which is a nice property, and also means bundle measurements need a
placeholder key to be meaningful.

**Do not submit an address lookup against a real API key just to look at the
UI.** Geocoding and the footprint lookup are free NYC open-data services, but
a successful lookup also fires the one metered step — the Cesium render — the
moment a key is present. Everything short of that render (the form, the
landmark presets, validation, both honest-failure states, narrow/mobile
layouts) can be exercised with no address ever submitted, or with `View from
here` clicked on an empty field.

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
   │                                      GROUNDELEV)                │
   │                                                                 ▼
   │                                        neighbour footprints ──► per-direction enclosure
   │                                        (same NYC dataset)       (obstruction angle, first
   │                                                                  blocking distance, band)
   │                                   └─► ViewPlan (real coords, real elevation, real bearings,
   │                                                 real enclosure — or no notes at all)
   │
   └─ (2) RENDER — key-gated, the only metered step
          CesiumJS + Google Photorealistic 3D Tiles, ONE session
          openRenderSession() ──► AsyncIterable<CaptureEvent>
             session-open · view-started · view-captured · view-failed · session-closed
          each frame handed to the UI the moment it exists
```

**Why this split is the whole ballgame:** the geometry half can only ever decide
*where a real camera goes*. It cannot produce a scene. The render half streams
Google's real photogrammetric mesh. So there is no code path — success, error,
partial success, retry, abort, or no-key — that can fabricate imagery.

### The render is a stream, not a batch

`openRenderSession()` returns an async iterable of events rather than a
`Promise<CaptureResult[]>`. Two reasons, both concrete:

1. **The frames used to be withheld, not awaited.** The old `renderFourViews()`
   captured the views in a serial loop and each was a finished, attributed PNG
   in hand at the end of its iteration — pushed onto a local array nothing
   returned until the fourth finished. Measured from the committed proof runs:
   the first frame existed at ~10–16 s and reached the screen at 37–62 s.
2. **One throw destroyed everything.** A canvas-readback `SecurityError` on the
   third view propagated out of the whole function and discarded the two frames
   that had already succeeded. Per-view `try`/`catch` and per-event delivery
   make that impossible.

An async iterable rather than an `onCapture` callback because partial success
becomes expressible *in the type*: "three landed, one didn't" is a sequence of
events, not a rejected promise or a convention about a short array.

The **policy** (retry limits, ordering, abort, what counts as fatal) lives in
`viewer/renderSession.ts`, separately from `viewer/tileRenderer.ts`, which owns
Cesium. That is what lets `renderSession.test.ts` drive fifteen cases through a
fake frame source with no WebGL, no key and no provider request — the
interesting behaviour is exactly the behaviour that would otherwise cost money
to exercise.

### Retry, and what it costs

The billable unit is the **root tileset request** — one per session, not one
per frame. *"Timed session tokens allow for up to three hours of renderer tile
requests from a single root tileset request"* (Map Tiles usage & billing, read
2026-08-05). So:

| Situation | What the app offers | Cost |
| --- | --- | --- |
| A direction fails while the session is open | automatic re-queue at the back of the queue, once; plus a **Retry this direction** button | **$0.00** |
| A direction failed and the session has closed | **Render all four again** | 1 root tileset request |
| The session never opened (403, no network) | **Render all four again** | 1 root tileset request |

Once the session is gone, re-capturing *one* direction costs exactly as much as
re-capturing *four*, so the per-direction button disappears rather than quietly
charging for a full render. There is no idle hold on the WebGL context; keeping
one alive for ~120 s to make later retries free was considered and declined.

**The automatic retry is the mechanism that matters; the button is narrow, and
that is worth saying out loud.** A failed direction is re-queued once at the
back of the queue, so a *single* failing direction usually reaches its terminal
state as the last item in the queue and the session closes immediately after —
leaving no window. The button is really for the case where two directions have
trouble, which is also when it is worth the most. Widening the window means the
idle hold.

### What the visitor sees while it works

No percentage, no invented stages, no ETA. A progress *bar* is not available
honestly — a capture ends on either a quiet period or a hard timeout, and
neither is a fraction of a known total.

What is shown is what the app knows. A **plan drawing** of the building's real
footprint with the four camera standoffs to scale appears within about a second
of the address resolving, from NYC open data, before any imagery exists. Four
labelled plates carry their real bearings from the same moment. Each plate
fills in as its frame lands; the corresponding axis on the plan goes from
hairline to solid. Every mark on that drawing corresponds to a completed unit
of work.

A direction that never loads keeps its label, its bearing and its arrow, and
shows an **empty frame**. Not a gradient, not a silhouette, not a
representative image.

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
| `src/lib/neighbors.ts` | Neighbouring footprints from the **same** NYC dataset, via `intersects()` on a WKT box. See "Why not `within_circle`" below. |
| `src/lib/confidence.ts` | Per-direction obstruction angle and first-blocking distance → open / partly enclosed / enclosed. **Pure. No pixels, no ray-casting against the provider mesh** — the module header says why. |
| `src/lib/cache.ts` | Geometry-only cache (localStorage). Rendered imagery is deliberately never cached — see below. |
| `src/lib/redact.ts` | Strips `key=` out of any provider error text, on every error path. |
| `src/lib/metrics.ts` | Addresses processed, geometry latency, cache hit rate, per-direction capture latency, time-to-first-frame, and **sessions opened** (the cost meter — see below). Recorded on every real run. No UI panel reads it today; it's there to be queried, not to be a dashboard. |
| `src/lib/config.ts` | The `VITE_GOOGLE_MAPS_KEY` gate. |
| `src/pipeline/planView.ts` | Orchestrates geocode → footprint → geometry → enclosure; routes **every** failure to the honest unavailable state. Deps injectable for tests. |
| `src/viewer/cesiumCamera.ts` | `CameraView` → Cesium camera (deg→rad orientation). |
| `src/viewer/tileRenderer.ts` | Owns Cesium: one session, one root tileset request, one `capture()` per view, attribution composited into each PNG. |
| `src/viewer/renderSession.ts` | Owns the *policy*: event ordering, per-direction retry, what is fatal, abort. No Cesium, so it is testable without a key. |
| `src/viewer/useTileCaptures.tsx` | Consumes the event stream and commits each frame as it arrives; per-slot state; key-gated; in-memory only. |
| `src/ui/notes.ts` | **Every sentence the app says about the limits of a result, in one file**, so the vocabulary is reviewable as a set. |
| `src/ui/PlanDiagram.tsx` | The plan drawing — our drawing of NYC's open data, no provider content involved. |
| `src/ui/*` | Form, states, the drawing sheet, attribution line. |
| `proof/*` | Browser harnesses. `run-proof`/`run-failure-paths`/`run-mismatch-proof` exercise the live services; `run-progressive-proof` exercises the streaming path against a stubbed renderer at $0.00; `make-confidence-fixtures` captures the offline test fixtures. |

**On the metrics panel:** an earlier build rendered `lib/metrics.ts`'s counters
in a visible "Pipeline metrics" panel on the main screen, reading `0 / 0 / 0%`
before a visitor had typed anything, with a footnote citing a Maps Platform
ToS clause number and the free-tier quota. The visual-authorship pass removed
that panel (and the CSS behind it) as decoration that added no information a
visitor needed before using the tool — real instrumentation numbers, shown
uninvited, still read as a stray dev panel. The counters themselves are
unchanged and still increment on every real request; they're just not wired
to any UI right now. Re-adding a surfaced view of them (behind a restrained
disclosure, only after a lookup) is a reasonable future change, not a
reversal of this one.

**Treat the imagery counters as draft estimates.** `sessionsOpened`,
`capturesCompleted`, `avgCaptureLatencyMs` and `lastTimeToFirstFrameMs` have
been exercised against stubs, which proves the arithmetic and nothing about the
wall-clock values. Nobody has run them against a real render, because doing so
costs a root tileset request and that has not been authorized.

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

### How enclosed is each direction — and why it isn't measured from the picture

The release-candidate proof package showed that the same building can produce a
photographic frame from floor 80 and a melted grey one from floor 6, and that
the difference is what's standing in front of the camera. 27B now says so, per
direction.

**It does not look at the imagery to find out.** Two approaches were available
and both are contractually closed:

- Reading back the captured PNG to measure sky fraction, edge density or blur.
  The Map Tiles API policies exclude *"Image analysis"* and *"Machine
  interpretation"*.
- `scene.pick` / `sampleHeight` / ray-casting against the loaded Google mesh.
  The same page excludes *"Geodata extraction"* and requires that overlaid
  objects not be *"derived by hand or machine from Photorealistic 3D Tiles"*;
  ToS §3.2.3(c) separately prohibits creating content from Google Maps Content.
  This one deserves emphasis, because it is what a competent engineer reaches
  for first, it is three lines away in an API this app already imports, and it
  would give a *better* answer. It is not available to us, and the reason is
  written into the header of `lib/confidence.ts` so it isn't quietly
  "improved" back in later.

What is left is NYC Open Data — free, keyless, ours, and already the source of
the subject building's footprint. Per direction: over neighbouring footprints
inside a ±37.5° cone and 220 m, the greatest angle above the eye line, and the
distance to the first thing that rises above it. Both terms stay in NAVD88, the
datum they arrive in, so the GEOID18 conversion the camera needs cannot
introduce error here.

The dividing line the codebase encodes: **we may report whether our capture
completed; we may never report what is in the picture.** "Still sharpening when
this frame was captured" is a statement about our own render loop. "This frame
looks blurry" would be image analysis.

**Why not `within_circle`.** SoQL's `within_circle()` on a polygon column means
*entirely contained*, not *intersects*. Measured against the live free endpoint
on 2026-08-05, centred on the Empire State Building's own centroid: a 40 m
circle returns **zero** rows — the ESB is excluded from a circle centred on
itself, because its footprint half-diagonal is about 96 m. Any obstruction
analysis built that way silently omits exactly the large straddling towers that
block views. `intersects()` with a WKT box is used instead (202 rows / 162 KB /
1.3 s in the densest case measured), and the consequence is pinned by a test.

**The band thresholds are honest about their provenance.** They are fitted to
the sixteen directions in the existing proof package, whose visual quality was
described in that report *before* any metric was run against them. On that set
every direction called photographic lands in `open` and every one called
melted, blurred or unreadable lands in `enclosed`. That is *consistent with*
those cases — **not validated on unseen data**, because the calibration set and
the motivating set are the same sixteen. One known over-warn (425 E 79th at
119°) is recorded rather than tuned away; over-warning is the correct direction
to err here. Numbers:
`docs/repair/personal-authorship-sprint/evidence/27b-confidence-calibration.json`.

If the neighbour lookup fails or times out, the plan is produced anyway with no
enclosure notes at all. "No notes available" is never read as "open".

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

## Visual language

A result is a **sheet of drawings**: a plan in the margin, four elevations
beside it, and the notes that qualify them. That is the shape the subject
suggests — this is an app about where a camera stands relative to a building —
and it is what distinguishes 27B from the other surfaces in the suite rather
than making it a third skin of one component library.

Consequences worth naming, because they are choices:

- The plan is drawn to scale from the real footprint ring and the real camera
  standoffs, and it appears about a second in, before any imagery exists. It is
  our drawing of NYC's open data; no provider content is involved.
- It doubles as the progress display. Hairline axis = queued, solid = the frame
  has landed, faint = it didn't. There is no bar and no percentage, because
  there is no denominator.
- Each plate's caption sits **above** its frame, not floating over it, so a
  pane with no imagery is still a labelled plate rather than an empty box with
  text in the middle of it.
- Per-direction notes are silent by default. An open view says nothing at all;
  a line of reassurance under every frame would make the frames that genuinely
  need a warning harder to notice.

`src/index.css` otherwise follows the suite-wide visual authorship pass:
one shared dark ground (matching the tone the portfolio presents its business
card against, not a colour 27B chose on its own), the one project accent
declared in `apps/portfolio/src/config/site.ts` (`#5d7a91`) used exactly
once — the "floor 27B" text in the headline — never as a button fill, a
focus glow, or a badge colour, and no `border-radius` anywhere, since nothing
in this UI represents a physical object the way the portfolio's business card
does. Containers (the result state boxes, the four view frames) only appear
where a border separates two genuinely different kinds of material; nothing
sits in a box just because it's text. Technical detail that's real but not
part of the primary question — NAVD88/WGS84/geoid figures, BIN, roof
height — lives behind a closed-by-default `<details>` disclosure rather than
inline in the result header.

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
| Neighbour lookup fails or times out | Full result, **no** enclosure notes | 0 | None — silence, never "open". |
| One direction fails, session still open | 3 of 4 real frames; the 4th pane empty, labelled, with a free retry | — | None — empty pane, no substitute. |
| One direction fails, session closed | 3 of 4 real frames; *"3 of 4 directions loaded."*; **Render all four again** | — | None. |
| The session never opens (403, no network) | Four empty labelled panes + one honest sentence | — | None — 0 `<img>`, 0 `<canvas>`. |
| Floor above the roof | Real render, clamped to roof + flagged | 1 root tileset | None — refuses to exceed real height. |

There is **no** procedural / block-model / placeholder scene anywhere in the
codebase. Missing real data always resolves to a truthful message.

The last three rows were verified in a real browser on 2026-08-05 by
`proof/run-progressive-proof.mjs`, which intercepts the renderer chunk and
replaces it with a stub, so it exercises every one of those paths at **$0.00**
and records every request the page makes. Result:
`docs/repair/personal-authorship-sprint/evidence/27b-browser-trace.json` —
zero provider requests across all five cases, and zero `<img>`/`<canvas>` in
the result whenever imagery did not load.

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
- **No AI pass on this imagery — dropped permanently, not deferred.** The v1
  feature list originally called for "AI compositing" on top of the real source
  imagery. On this provider path that is not available to us, so it has been
  **removed from scope** rather than parked as a limitation. The Map Tiles API
  policies restrict the API to visualization and specifically exclude *"Image
  analysis"* and *"Machine interpretation"*; ToS §3.2.3(c) ("No Creating Content
  From Google Maps Content") separately prohibits creating content from it,
  including (vii) using it to "train, test, validate or fine-tune" AI models.
  The depth/ControlNet photorealism pass sketched in `research/27b-imagery.md`
  §1 Step 3 is therefore not permissible and is not built.

  Concretely, 27B does not and will not: alter provider imagery with generative
  AI; remove, obscure or restyle attribution; upscale frames via generative
  reconstruction; fill unavailable or occluded areas synthetically; or present
  an enhanced image as provider-original. **Real rendered frames, plus separate
  UI annotation drawn outside the image, is the whole pipeline.** The one thing
  composited into the PNG is the attribution bar itself, which the policy
  requires to travel with the pixels.

  This is also the stronger honesty position: "no AI touches the imagery path"
  is a claim that survives inspection, which "AI-enhanced photorealism" would
  not.

### The Cesium "Google geocoder only" warning

CesiumJS prints a one-time console warning — *"Only the Google geocoder can be
used with Google Photorealistic 3D Tiles"* — unless you pass
`onlyUsingWithGoogleGeocoder: true`. 27B geocodes with NYC Planning GeoSearch,
so **we leave the flag unset and let the warning print.** The flag changes
nothing except whether the message appears; setting it would be attesting to
something untrue about this app in order to silence a message.

**Exactly what it costs, measured.** It is `oneTimeWarning`, which caches by
identifier in module scope, so it is emitted **once per page load** — not once
per render, and not once per direction. A second lookup in the same tab is
silent. Read from `@cesium/engine` `Source/Scene/createGooglePhotorealistic3D-
Tileset.js` at cesium@1.143.0, where the whole of the mechanism is:

```js
if (!apiOptions.onlyUsingWithGoogleGeocoder) {
  oneTimeWarning("google-tiles-with-google-geocoder", "Only the Google geocoder …");
}
```

The one alternative that would remove it without asserting anything untrue is to
stop calling the helper and construct the tileset from `GoogleMaps.mapTilesApi-
Endpoint` directly, since the only other thing the helper does is fall back to a
Cesium Ion–hosted copy when no key is resolvable — a fallback this app already
refuses explicitly (`tileRenderer.ts`). **We have not done that.** Re-implementing
a provider helper so a console stays quiet trades a visible, explained warning
for an invisible divergence from the vendor's own code path, including its
`cacheBytes` defaults and its attribution credit. The warning is the better
failure mode.

**So it is accounted for rather than filtered.** The acceptance harness
(`proof/eval-matrix.mjs`) declares it in `EXPECTED_NOTICES` with this reasoning
and reports it separately from console problems, so a run's console output is
either on that list or is a defect. It is the only entry on the list.

Re-checked 2026-08-04 for any Google-side basis for the restriction. None found
in: [Photorealistic 3D Tiles](https://developers.google.com/maps/documentation/tile/3d-tiles)
(updated 2026-07-31) · [3D Tiles overview](https://developers.google.com/maps/documentation/tile/3d-tiles-overview)
(2026-07-31) · [Work with a 3D Tiles renderer](https://developers.google.com/maps/documentation/tile/use-renderer)
(2026-07-31) · [Map Tiles API Policies](https://developers.google.com/maps/documentation/tile/policies)
(2026-07-31) · [Maps Platform ToS](https://cloud.google.com/maps-platform/terms)
(last modified 2026-06-23; **zero** occurrences of "geocoder") · [Maps Service
Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)
(last modified 2026-06-10; **zero** occurrences of "geocoder", and no Map Tiles
section at all). Cesium's own [Appendix B-2 third-party terms for Google Maps
Content](https://cesium.com/legal/terms-for-google/) (2025-08-20) states no
geocoder requirement either.

The nearest applicable clause is ToS §3.2.3(e) "No Use With Non-Google Maps",
which concerns displaying Google Maps Content with or near a non-Google **map**.
27B's viewer disables the base imagery layer and hides the globe, so no map of
any kind is displayed alongside the tiles, and no non-Google map exists anywhere
in the app.

This section records an **absence of evidence, not a legal conclusion.** We did
not find a basis; that is not the same as proving none exists, and this is not
legal advice. Residual risk is judged low. If it matters commercially, the
clean resolutions are to ask Google directly or to switch to the Google
Geocoding API — the latter costs the NYC-open-data story and the BIN join that
the footprint lookup depends on, which is a large part of what makes the project
interesting.

### Troubleshooting the render

If a key is set but every view shows "Imagery didn't load for this view.",
check the browser console — the actual cause is logged there (an earlier
build put this diagnosis in the on-screen notice itself, which meant a
Google Cloud Console walkthrough was rendered over a supposedly finished
building view; that's an operator runbook, not visitor copy, so it moved
here instead). The most common cause by far:

- **A `403` from `tile.googleapis.com`.** The key exists but either the
  **Map Tiles API** isn't enabled for the project (**APIs & Services →
  Library → Map Tiles API → Enable**), or the key has an HTTP-referrer
  restriction that doesn't include the origin you're loading from (`Map Tiles
  API` keys restricted to a deploy domain will 403 against `localhost`, and
  vice versa — use separate keys for dev and prod, per
  `docs/BILLING_AND_QUOTA.md`).
- **Billing not enabled on the project.** The Map Tiles API requires it even
  to stay inside the free monthly allotment.

Whatever the cause, the honest failure holds regardless: no image renders,
and nothing is drawn in its place.

### Cost, quota and abuse controls

See [`docs/BILLING_AND_QUOTA.md`](docs/BILLING_AND_QUOTA.md) for the meter and
the control set, and [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the host,
the response headers and the pre-deploy checklist. Both are **plans, not
implementations** — none of those controls exist in code today, no account has
been created, nothing has been deployed, and 27B must not be exposed on a
public origin until they do exist.

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

Because the session is the billable unit, a per-direction retry *inside an open
session* is free, and `metrics.ts` counts **sessions opened**, not frames
captured — a frame counter would produce a number that doesn't match the bill.
`renderSession.test.ts` asserts that a run containing a retry still emits
exactly one `session-open`, because that is a billing invariant no type checks.

> ⚠️ **First paid point — flag before crossing.** Exceeding 1,000 renders/month
> triggers per-request billing. That must be an explicit cost decision.

Free-and-unmetered: GeoSearch geocoding, NYC OpenData footprints, and the baked
GEOID18 lattice (no runtime NOAA dependency).

---

## Proof harnesses

```bash
# Free, no key, no provider request — run these first.
#
# offline test fixtures: real footprints from two free, keyless NYC services
node apps/27b/proof/make-confidence-fixtures.mjs

# progressive render, partial failure, session failure, mobile — the renderer
# chunk is intercepted and stubbed, so no root tileset request is possible
VITE_GOOGLE_MAPS_KEY=placeholder npm run build -w @portfolio-suite/27b
(cd apps/27b && npx vite preview --port 5175 --strictPort &)
mkdir -p /tmp/pw && (cd /tmp/pw && npm i playwright)
NODE_PATH=/tmp/pw/node_modules node apps/27b/proof/run-progressive-proof.mjs

# ---- these two SPEND. One root tileset request each (~$0.006). ----
# happy path: one address, two floors, four facade views, real tiles
npm run dev -w @portfolio-suite/27b
NODE_PATH=/tmp/pw/node_modules node apps/27b/proof/run-proof.mjs

# failure paths: non-NYC, unresolvable address, no key (0 tile requests)
NODE_PATH=/tmp/pw/node_modules node apps/27b/proof/run-failure-paths.mjs
```

`proof/evidence/summary.json` and `proof/evidence/failure-paths.json` are
committed. The **screenshots and frame PNGs are not** — they contain Google Maps
Content, and §3.2.3(a)/(b) say not to store or re-share it. They stay on the
machine that produced them.

### Reviewing the proof package

The images live at `apps/27b/proof/evidence/` **on the machine that captured
them** (2026-08-04) — they're gitignored on purpose, so a fresh clone won't
have them. `proof/evidence/INDEX.md` is a plain-language guide to that folder:
a recommended viewing order, a one-line label for every image, and pointers to
the JSON files that are safe to keep. It doesn't repeat the compliance or
provider analysis — that's `docs/repair/release-candidate/27b/REPORT.md`,
whose §12 is the actual decision page (three options: accept this provider
direction, reject it, or request one bounded change). Start with
`proof/evidence/INDEX.md`, then read REPORT.md §7–§12 with the images open
side by side.
