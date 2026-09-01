"""Route-wiring tests: does the HTTP layer serialize the domain result
correctly (camelCase, always-200), not the planning logic itself -- that's
covered in test_planning.py. planning.plan_view is monkeypatched here so no
real network call happens."""

from fastapi.testclient import TestClient

import main
import models
import planning


def test_view_plan_returns_200_with_camel_case_body_on_success(monkeypatch):
    plan = models.ViewPlan(
        address="350 5th Ave",
        floor=80,
        geocode=models.GeocodeResult(label="350 5 AVENUE, New York, NY, USA", lat=40.75, lng=-73.99, bin="1015862"),
        footprint=models.FootprintSummary(
            bin="1015862", roof_height_m=380, ground_elevation_navd88_m=15, centroid=models.LatLng(lat=40.75, lng=-73.99)
        ),
        curated_name="Empire State Building",
        eye_elevation_navd88_m=270,
        eye_elevation_ellipsoidal_m=238,
        geoid_height_m=-32,
        floor_clamped_to_roof=False,
        basis="facade",
        views=[
            models.CameraView(slot="V1", heading_deg=29, compass="NNE", lat=40.751, lng=-73.989, height_m=238, pitch_deg=-9, standoff_m=12)
        ],
    )

    async def fake_plan_view(address, floor, **_kwargs):
        return models.ViewPlanResponse(ok=True, plan=plan)

    monkeypatch.setattr(planning, "plan_view", fake_plan_view)

    client = TestClient(main.app)
    res = client.post("/api/view-plan", json={"address": "350 5th Ave", "floor": 80})
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    # camelCase on the wire, matching the frontend's TS field names.
    assert body["plan"]["curatedName"] == "Empire State Building"
    assert body["plan"]["eyeElevationNavd88M"] == 270
    assert body["plan"]["views"][0]["headingDeg"] == 29


def test_view_plan_unavailable_reason_still_returns_200(monkeypatch):
    async def fake_plan_view(address, floor, **_kwargs):
        return models.ViewPlanResponse(ok=False, reason="not-supported", message="nope")

    monkeypatch.setattr(planning, "plan_view", fake_plan_view)

    client = TestClient(main.app)
    res = client.post("/api/view-plan", json={"address": "1 Nowhere St", "floor": 3})
    # The whole point of the typed-result contract: an expected domain
    # failure is not an HTTP error status.
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert body["reason"] == "not-supported"
    assert body["plan"] is None


def test_curated_buildings_returns_the_real_list():
    client = TestClient(main.app)
    res = client.get("/api/curated-buildings")
    assert res.status_code == 200
    body = res.json()
    assert len(body) == 5
    names = {b["name"] for b in body}
    assert "Empire State Building" in names
    # camelCase on the wire.
    esb = next(b for b in body if b["name"] == "Empire State Building")
    assert esb["suggestedFloor"] == 80
    assert esb["floors"] == {"min": 50, "max": 102}
