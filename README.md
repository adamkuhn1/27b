# 27B

**A New York address and a floor. Four real renders of approximately what
you'd see.**

27B takes a NYC address and a floor number, works out where that floor's
windows are and which way each facade faces, and renders four views from just
outside those facades using **Google Photorealistic 3D Tiles** (via CesiumJS)
— real photogrammetry of the real city, shipped exactly as captured. There is
no generative step, no compositing, no pixel analysis: the only thing ever
drawn onto an output frame is the required attribution bar.

## Two processes, not a distributed system

This is a React frontend and a small Python planning API, run as two local
processes -- not microservices, not a deployed backend. The split exists for
one reason: to put a real language/architecture boundary between "figure out
where a camera goes" and "render what's there." The **frontend** is the UI,
the Google Maps key, the lazy-loaded Cesium renderer, and nothing else. The
**backend** (`backend/`, FastAPI) does the geocoding, the curated-building
gate, the NYC Open Data footprint lookup, and the camera math -- and never
talks to Google's imagery at all. See "Pipeline architecture" below for
which half does what, and `backend/models.py` for why every backend
response is a typed value, never an HTTP error, for anything the pipeline
can anticipate.

## Run it

Two terminals -- the backend and the frontend dev server run independently.

```sh
# Terminal 1: the planning backend
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
pytest                        # unit tests: geometry, address-matching,
                               # footprint parsing, the plan_view pipeline
                               # (all pure/injected-deps -- no live network)

# Terminal 2: the frontend
npm install
cp .env.example .env.local    # then fill in the Google key (optional — see below)
npm run dev                   # http://localhost:5174 -- proxies /api to
                               # the backend above (see vite.config.ts)
npm run build                 # production build (compiles Cesium; ~25 s)
npm test                      # frontend unit tests (renderer/UI logic only
                               # now -- the planning math moved to backend/)
npm run typecheck
```

`npm run build` only builds the frontend. This migration does not add a
production deploy path for the backend -- see "Known limitations."

### Environment

| Variable | Purpose |
| --- | --- |
| `VITE_GOOGLE_MAPS_KEY` | Google Maps Platform key with the **Map Tiles API** enabled (Photorealistic 3D Tiles). Gates the renderer only. |

Everything except the final render — geocoding, building lookup, elevation
and heading math, the full UI, all failure states — works with **no key**.
With no key set the app shows an honest "imagery source not configured"
state. It never substitutes a placeholder or simulated scene.

**Cost:** billing is per *root tileset request*, roughly one per render
session (four directions share one session; in-session retries are free).
Free tier is ~1,000/month, then ~$6/1,000. Renders only happen for the
curated building list below, which keeps ordinary use far inside the free
tier. Google's terms prohibit caching the imagery, so the app deliberately
does not — a repeat lookup is a new render. Set a daily quota cap in the
Cloud console before any public deploy.

## What's supported, and why it's a short list

**27B does not promise "any NYC address," on purpose.** The provider's mesh
has a fixed resolution ceiling. When the camera's subject is hundreds of
meters away — a tall floor, or a facade facing a park or river — the render
is genuinely photographic. When the subject is a facade across a 20 m street
(the typical mid-block apartment), the render is a melted, artifact-heavy
texture, and no application code can fix that: it is the source data's
ceiling, verified at length in a rendering bake-off before the curated list
below was settled on.

So the app renders only buildings and floor ranges that were **rendered live
and visually accepted, all four directions**, on 2026-08-11:

| Building | Address | Floors | Verified by rendering |
| --- | --- | --- | --- |
| Empire State Building | 350 5th Ave | 50–102 | floors 50 and 80 |
| 432 Park Avenue | 432 Park Ave | 70–85 | floor 70 (45 failed) |
| The San Remo | 145 Central Park West | 20–27 | floor 20 (15 failed) |
| 1 Central Park West | 1 Central Park West | 35–44 | floor 35 (25 failed) |
| The Brooklyn Tower | 9 DeKalb Ave, Brooklyn | 70–73 | floor 70 (45 failed) |

Floor-range policy: the range **minimum is a live-verified floor**. Floors
above it are allowed on a geometric argument, not a render — raising the
camera over the same neighbours only lengthens every sightline. The maximum
is the building's real top floor and always keeps the estimated eye under the
dataset's roof height.

Everything else — including real, correctly geocoded addresses — gets a
first-class **"we don't have a good view for this one yet"** state that names
the supported buildings. Matching is by BIN (the city's building ID), so any
spelling of a supported address works and no unsupported building can match
by accident.

### How the list was verified

Sixteen candidate buildings were rendered in full (four directions each; one
at two different floors) plus five range-minimum probes: 22 billable
sessions, ~2% of one month's free tier, driven through the real app in
headless Chrome. Every frame was saved and reviewed by eye; a building
shipped only if **all four** directions passed. Eleven candidates were
rejected (The Dakota, the Flatiron, 8 Spruce St, One Manhattan Square,
220 Central Park South, 70 Pine St, 30 Park Place, The Beresford, One57,
One Madison, Skyline Tower) — in every case because some direction
faced a facade or roof structure inside ~50 m, which is exactly the mesh
ceiling described above. The review frames are provider imagery and are
therefore **not stored in this repo** (caching/retention is prohibited);
re-running the review is a matter of clicking the five picker chips plus any
rejected address and looking.

## Pipeline architecture

```
FRONTEND (React)                    BACKEND (Python / FastAPI)
address + floor
  ── POST /api/view-plan ──▶
                                       → geocode            NYC Planning GeoSearch (free,
                                       |                    keyless, NYC-only — doubles as the
                                       |                    "is this NYC" gate). The result is
                                       |                    verified against the typed address
                                       |                    (housenumber/street BEFORE locality)
                                       |                    so a fuzzy geocoder fallback can
                                       |                    never silently substitute a
                                       |                    different real building.
                                       → curated gate       BIN looked up in the verified list.
                                       |                    Unsupported → honest state, zero
                                       |                    further cost.
                                       → footprint          NYC Open Data Building Footprints
                                       |                    (free, keyless): roof height, ground
                                       |                    elevation (NAVD88), polygon ring.
                                       → elevation          floor → eye height (3.2 m/floor +
                                       |                    1.5 m eye, clamped to the real
                                       |                    roof), then NAVD88 → WGS84
                                       |                    ellipsoidal via a baked GEOID18
                                       |                    lattice. Skipping this conversion is
                                       |                    a silent ~32 m (ten-floor) error —
                                       |                    it is load-bearing.
                                       → camera math        dominant facade axis from the
                                       |                    footprint edges (length-weighted
                                       |                    exp(4iθ); ~29° on the Manhattan
                                       |                    grid, verified on the real ESB
                                       |                    footprint), four outward normals,
                                       |                    camera pushed past the OUTERMOST
                                       |                    wall crossing + 6 m and verified
                                       |                    outside the polygon. Round/irregular
                                       |                    footprints fall back to true compass
                                       |                    bearings, and the UI says so.
  ◀── typed ViewPlan or ──────────────┘
      an honest unavailable reason
      (always HTTP 200 — see
      backend/models.py)
  → render             one offscreen Cesium session, Google Photorealistic
  |                    3D Tiles, driven by the camera plan above. FOV 75°,
  |                    preserveDrawingBuffer, warm-up pumping, per-view
  |                    tile-settle wait. A frame that drew zero provider
  |                    triangles is reported as failed — never shown. (That
  |                    check reads our renderer's scene stats, not pixels.)
  → attribution        the per-frame credits Google returns are baked into
  |                    the PNG as a bottom bar — the only compositing in the
  |                    pipeline.
  → display            up to four frames, labelled with true compass
                       bearings, under copy that says "approximately what
                       you'd see" — never "your actual view".
```

Backend source files (`backend/`): `main.py` (the two FastAPI routes),
`planning.py` (geocoding, address-match verification, the curated gate,
footprint fetch, and the `plan_view` orchestration — everything above the
line), `geometry.py` (the pure camera/datum math — everything above the
line's actual arithmetic, plus the baked GEOID18 lattice), `models.py` (the
typed request/response contract). No database, no auth, no queues, no
Docker — four files, stdlib math, one HTTP client (`httpx`).

Frontend source files (`src/`): `lib/api.ts` (the two fetch calls to the
backend above, and the only place the frontend knows the backend exists),
`viewer/tileRenderer.ts` (Cesium session + capture, unchanged by this
migration), `viewer/attributionBar.ts` (bar layout, unit-tested,
unchanged). `lib/types.ts` now describes the wire contract instead of
computing it.

Cesium (~1.7 MB gzipped) lives in a lazy chunk loaded only when a render
actually starts; visitors who never pass the form never download it.

## Honesty rules (enforced in code, not just copy)

- **Real imagery only.** No AI generation, enhancement, or compositing —
  Google's Map Tiles ToS prohibits running models over this imagery, and the
  product doesn't need it. No pixel of a frame is ever analysed.
- **No fabricated scenes anywhere**, including error paths. Footprint
  heights place cameras; they are never extruded into a scene. Every failure
  (bad address, missing footprint, service down, no key, failed capture) is a
  message, not a picture.
- **No silent substitution.** An address the geocoder can't verify
  fails honestly (`backend/planning.py`'s `verify_address_match` — checks
  house number and street before locality, which is what catches Pelias's
  confident fuzzy fallbacks).
- **No imagery caching.** Only free, keyless municipal *geometry* may be
  cached; provider pixels never are (and currently nothing is).
- **Estimates are labelled.** Floor height is an assumption (3.2 m/floor)
  and the UI says "approximately what you'd see" everywhere.

## Known limitations

- **The mesh-quality ceiling.** Anything within ~50 m of the camera renders
  poorly at these standoffs. This is the provider's resolution limit, not a
  tuning problem — it is why the curated list exists.
- **Floor height is an estimate.** 3.2 m per floor plus a 1.5 m eye; real
  buildings vary (lobbies, mechanical floors), so "floor 50" is approximate
  by a floor or two on tall buildings.
- **Height-only vertical framing.** The camera stands just outside the
  facade at the estimated eye height; there is no per-floor parallax beyond
  height.
- **Dataset quirks.** NYC Open Data roof heights are occasionally wrong
  (56 Leonard's record reads 255 ft against a real ~820 ft), which is one
  reason candidates are verified by rendering, not by arithmetic alone.
- **Repeat lookups re-render.** Required by the no-caching terms; each is a
  new billable event.
- **No production deploy path for the backend, yet.** This migration adds a
  local FastAPI process (`backend/`) and wires the frontend to it via a Vite
  dev-server proxy; it does not add hosting, a process manager, HTTPS, or a
  production CORS origin for it. Running both halves locally (see "Run it")
  is the only supported way to use this app right now — consistent with the
  rest of the suite staying private and undeployed.
