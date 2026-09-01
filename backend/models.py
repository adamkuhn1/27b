"""API contract: the typed shapes /api/view-plan and /api/curated-buildings
exchange with the frontend.

Field names are camelCase on the wire (via Pydantic's alias generator) to
match the frontend's TS types. Every response from /api/view-plan is
`ViewPlanResponse` -- success and every documented failure reason alike --
never an HTTP error status. See planning.py for why.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class ApiModel(BaseModel):
    """Base for every wire model: camelCase JSON, snake_case Python."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


UnavailableReason = Literal[
    "not-nyc",  # address is outside NYC / validation failed
    "geocode-failed",  # address could not be resolved
    "no-footprint",  # no building footprint/height record found
    "network-error",  # upstream data service failed
    "not-supported",  # real address, but outside the curated supported set
]

ViewBasis = Literal["facade", "compass"]
"""How the four view bearings were chosen -- see geometry.py's
view_bearings()."""


class GeocodeResult(ApiModel):
    """A geocoded NYC address. lat/lng are WGS84 decimal degrees."""

    label: str
    """The label the geocoder resolved (canonical; may differ from input)."""
    lat: float
    lng: float
    bin: str | None = None
    """NYC Building Identification Number, when the geocoder returns one."""
    borough: str | None = None


class LatLng(ApiModel):
    lat: float
    lng: float


class FootprintSummary(ApiModel):
    """Building geometry, trimmed for the wire: the client renders cameras,
    not footprints, so the polygon ring (which can run to dozens of points)
    stays server-side -- it did its job producing the camera views below."""

    bin: str
    roof_height_m: float
    """Roof height above ground, meters."""
    ground_elevation_navd88_m: float
    """Ground elevation, meters above the NAVD88 geoid."""
    centroid: LatLng


class CameraView(ApiModel):
    """The resolved camera vantage for one view. This is what the Cesium
    viewer consumes verbatim -- real coordinates, real elevation, a real
    bearing. No scene data is implied."""

    slot: Literal["V1", "V2", "V3", "V4"]
    heading_deg: float
    """True compass bearing the camera looks along (0 = true north,
    clockwise)."""
    compass: str
    """16-point compass label for heading_deg (display only)."""
    lat: float
    lng: float
    """Camera position: real lat/lng, just outside the facade it looks out
    from."""
    height_m: float
    """WGS84 **ellipsoidal** height (m) -- the value Cesium consumes."""
    pitch_deg: float
    """Pitch in degrees; 0 = horizon, negative = looking down."""
    standoff_m: float
    """Meters from the footprint centroid to the camera along heading_deg."""


class SupportedFloors(ApiModel):
    min: int
    max: int


class ViewPlan(ApiModel):
    """Everything the geometry half produces for a request, plus the
    curated-list entry that authorised the render. Fully derived from real
    data; this is the contract handed to the renderer."""

    address: str
    floor: int
    geocode: GeocodeResult
    footprint: FootprintSummary
    curated_name: str
    """The curated building this plan matched (renders are curated-only)."""
    eye_elevation_navd88_m: float
    """Eye elevation in the SOURCE datum (NAVD88 orthometric), meters."""
    eye_elevation_ellipsoidal_m: float
    """Eye elevation as WGS84 ellipsoidal height (what the renderer uses)."""
    geoid_height_m: float
    """GEOID18 undulation applied at this building (m; ~-31.7 in NYC)."""
    floor_clamped_to_roof: bool
    """True when the floor was clamped to the building roof."""
    basis: ViewBasis
    """How the four bearings were chosen -- surfaced in the UI, never
    implied."""
    views: list[CameraView]


class ViewPlanRequest(ApiModel):
    address: str
    floor: int


class ViewPlanResponse(ApiModel):
    """Discriminated on `ok`. Every branch -- success, a bad address, an
    unsupported building, an unreachable upstream service, missing
    geometry -- is this same typed shape at HTTP 200; there is no
    ok:false-via-4xx/5xx path for an expected outcome. See planning.py."""

    ok: bool
    plan: ViewPlan | None = None
    reason: UnavailableReason | None = None
    message: str | None = None
    supported_floors: SupportedFloors | None = None
    """For `not-supported` only: the floor window that IS verified at this
    building, when the address matched a curated building but the floor
    fell outside its verified range."""


class CuratedBuilding(ApiModel):
    """One entry in the supported-building list the picker chips render.
    See planning.py's CURATED_BUILDINGS for why this list is short and how
    it was verified."""

    name: str
    address: str
    bin: str
    floors: SupportedFloors
    suggested_floor: int
    note: str
    verified_at: str
