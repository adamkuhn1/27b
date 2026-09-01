"""27B's planning API: a very small FastAPI app in front of planning.py.

Two routes, both read-only from the client's perspective:

  POST /api/view-plan          address + floor -> ViewPlanResponse
  GET  /api/curated-buildings  the supported-building list (picker chips)

This process does the geometry -- geocoding, the curated-building gate,
footprint/elevation lookups, camera math -- and nothing else. It never talks
to Google's imagery: Cesium and the Google Maps key stay entirely in the
frontend, which renders the plan this returns. No database, no auth, no
background jobs; run it with `uvicorn main:app --reload` alongside `npm run
dev` (see the frontend's vite.config.ts for the /api proxy).
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import models
import planning

app = FastAPI(title="27B planning API")

# Local dev only. The Vite dev server proxies /api to this same origin
# (vite.config.ts), which sidesteps CORS for the normal `npm run dev` path;
# this is a fallback for hitting the API directly (curl, a second tab).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5174", "http://127.0.0.1:5174"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.post("/api/view-plan", response_model=models.ViewPlanResponse)
async def view_plan(request: models.ViewPlanRequest) -> models.ViewPlanResponse:
    """Always returns HTTP 200 with a typed ok:true/false body -- every
    documented failure reason (bad address, unsupported building, an
    upstream service being down, missing geometry) is data, not an HTTP
    error status. See planning.plan_view and models.ViewPlanResponse."""
    return await planning.plan_view(request.address, request.floor)


@app.get("/api/curated-buildings", response_model=list[models.CuratedBuilding])
async def curated_buildings() -> list[models.CuratedBuilding]:
    """The supported-building list the frontend's picker chips render.
    Static, in-process data -- see planning.CURATED_BUILDINGS."""
    return planning.CURATED_BUILDINGS
