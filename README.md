# 27B

Enter a New York address and a floor, and 27B renders four real photogrammetric
views of what you'd see out the windows on that floor.

## What it does

- Geocodes the address, looks up the building's footprint and height from
  NYC Open Data, and works out where a given floor's windows actually are.
- Aims four cameras along the building's own facades (not compass points) and
  places them just outside the wall in each direction.
- Renders those four vantages with **Google Photorealistic 3D Tiles** —
  real photogrammetry of the real city, no generative or synthetic imagery.
- Falls back to an honest "not supported yet" for anything outside a small,
  hand-verified list of buildings — never a broken or fabricated render.

## How it works

```
React / TypeScript / Cesium frontend
        ↓  POST /api/view-plan
Python / FastAPI planning API
        ↓
NYC GeoSearch + Open Data footprints, camera geometry
        ↓
Google Photorealistic 3D Tiles (rendered by the frontend)
```

The frontend handles the form, the Google Maps key, and the Cesium renderer.
The FastAPI backend (`backend/`) does everything upstream of a real camera
position: geocoding, address verification, the curated-building gate,
footprint lookup, and the geometry math. It never touches Google's imagery.
Every response — success or a specific failure reason — is a typed Pydantic
model (`backend/models.py`), not an HTTP error code.

The backend currently runs locally alongside the frontend dev server (see
"Run locally"); it has not been deployed.

## Technical highlights

- **Vertical-datum correction.** NYC's building-footprint elevations are
  NAVD88 orthometric heights; Cesium needs WGS84 ellipsoidal heights. The
  difference is about 32 m (ten floors) in NYC. `backend/geometry.py` applies
  a baked GEOID18 interpolation lattice to correct for it.
- **Facade-aligned cameras, not compass points.** A building's dominant wall
  orientation is recovered from its footprint edges (length-weighted
  `exp(4iθ)`, which is invariant to 90° rotation) — Manhattan's grid is ~29°
  off true north, and the four cameras aim along the building's own walls,
  not N/E/S/W. Footprints with no dominant orientation fall back to compass
  bearings, and the UI says so.
- **Address verification, not just geocoding.** NYC's GeoSearch API
  (Pelias) reports high confidence even on a fuzzy fallback match to a
  *different* building. The backend cross-checks the geocoder's own parsed
  query against the returned address (house number and street, before
  locality) and refuses anything that doesn't line up.
- **Curated coverage.** Google's mesh only looks photographic at long sight
  lines; an ordinary mid-block facade a few meters from the camera renders
  as melted texture. Rather than promise "any address," 27B ships a short
  list of buildings and floor ranges that were rendered and visually
  checked in all four directions before being listed.

## Run locally

Two processes — backend and frontend — run independently.

```sh
# Backend
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
pytest                        # unit tests, no live network

# Frontend (separate terminal)
npm install
cp .env.example .env.local    # optional — see below
npm run dev                   # http://localhost:5174, proxies /api to the backend
npm run build
npm test
npm run typecheck
```

`VITE_GOOGLE_MAPS_KEY` (a Google Maps Platform key with the Map Tiles API
enabled) gates only the final render. Everything else — geocoding, the
building lookup, the geometry, the full UI — works with no key; without one
the app shows an honest "imagery source not configured" state. Billing is
per render session (~$6/1,000 after a ~1,000/month free tier); the curated
building list keeps ordinary use well inside the free tier, and imagery is
never cached (Google's terms prohibit it, so a repeat lookup is a new render).

## Limitations

- **Mesh resolution ceiling.** Anything within ~50 m of the camera renders
  poorly — the provider's limit, not a tuning problem, and the reason the
  building list is curated rather than open-ended.
- **Floor height is an estimate** (3.2 m/floor, 1.5 m eye height), so tall
  buildings can be off by a floor or two.
- **Height-only framing.** The camera sits outside the facade at the
  estimated eye height; there's no per-floor lateral parallax.
- **Dataset quirks.** NYC Open Data roof heights are occasionally wrong
  (one record is off by nearly 3x), which is why candidates are verified
  by rendering, not by arithmetic alone.
- **No production deploy yet.** Both processes need to be run locally.
