"""The non-rendering planning pipeline: (address, floor) -> a typed plan, or
an honest, typed reason it can't be produced.

Ported from the frontend's src/lib/{geocode,addressMatch,footprint,curated,
planView}.ts (that TypeScript is now deleted; this is the only copy).
Orchestration:

    geocode -> verify match -> curated gate -> footprint -> elevation ->
    facade-relative cameras (geometry.py)

Every failure path returns a structured ViewPlanResponse(ok=False, ...) that
main.py hands straight back as an HTTP 200 body -- there is deliberately NO
code path here that fabricates coordinates, a building, or a scene, and NO
code path in main.py that turns one of these outcomes into an HTTP error
status. If real data is missing, the request is unavailable, full stop; see
the module docstring on models.ViewPlanResponse for why that stays a typed
value instead of an exception crossing the API boundary.

The curated gate sits BEFORE the footprint fetch on purpose: an unsupported
address costs one keyless geocode call and nothing else -- no Open Data
query.
"""

from __future__ import annotations

import asyncio
import re
import time
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

import geometry
import models

# ---------------------------------------------------------------------------
# The curated supported-building list, and why it exists.
#
# 27B does not promise "any NYC address." That promise was tried, at length,
# and the live evidence was unambiguous: Google's photorealistic mesh has a
# fixed resolution ceiling, and at 6 m from an ordinary mid-rise facade in a
# dense block -- the typical real address -- the render is a melted,
# artifact-heavy texture no application code can improve. A tall building, or
# a building facing open space (a park, a river, a wide avenue), renders
# genuinely photographically because the camera's subject is hundreds of
# meters away, where the mesh's meters-per-texel is flattering rather than
# fatal.
#
# So the product ships the honest subset: buildings and floor ranges where
# the technique was RENDERED AND LOOKED AT before being listed. Every entry's
# verified_at is the date its floors were live-rendered and visually
# accepted (see README "How the list was verified").
#
# Matching is by BIN -- the building identifier the geocoder returns -- so
# any spelling of a supported address matches, and no unsupported building
# can match by accident.
# ---------------------------------------------------------------------------

CURATED_BUILDINGS: list[models.CuratedBuilding] = [
    models.CuratedBuilding(
        name="Empire State Building",
        address="350 5th Ave, Manhattan, New York, NY 10118",
        bin="1015862",
        floors=models.SupportedFloors(min=50, max=102),
        suggested_floor=80,
        note="Tall enough that every direction clears the Midtown roofline.",
        verified_at="2026-08-11",
    ),
    models.CuratedBuilding(
        name="432 Park Avenue",
        address="432 Park Ave, Manhattan, New York, NY 10022",
        bin="1088817",
        floors=models.SupportedFloors(min=70, max=85),
        suggested_floor=70,
        note="Supertall over Midtown; Central Park fills the northwest frame.",
        verified_at="2026-08-11",
    ),
    models.CuratedBuilding(
        name="The San Remo",
        address="145 Central Park West, Manhattan, New York, NY 10023",
        bin="1028714",
        floors=models.SupportedFloors(min=20, max=27),
        suggested_floor=20,
        note="Central Park West classic; the park and its lake fill the east frame.",
        verified_at="2026-08-11",
    ),
    models.CuratedBuilding(
        name="1 Central Park West",
        address="1 Central Park West, Manhattan, New York, NY 10023",
        bin="1027191",
        floors=models.SupportedFloors(min=35, max=44),
        suggested_floor=35,
        note="Columbus Circle tower; park east, open circle south.",
        verified_at="2026-08-11",
    ),
    models.CuratedBuilding(
        name="The Brooklyn Tower",
        address="9 DeKalb Ave, Brooklyn, NY 11201",
        bin="3000370",
        floors=models.SupportedFloors(min=70, max=73),
        suggested_floor=70,
        note="Brooklyn's tallest; the harbor, the bridges, and brownstone Brooklyn below.",
        verified_at="2026-08-11",
    ),
]


def curated_by_bin(bin: str) -> models.CuratedBuilding | None:
    """Look up the curated entry for a building, by its BIN."""
    return next((b for b in CURATED_BUILDINGS if b.bin == bin), None)


# ---------------------------------------------------------------------------
# Address -> lat/lng + BIN via the NYC Planning GeoSearch API.
#
# GeoSearch (https://geosearch.planninglabs.nyc) is a free, key-less Pelias
# instance that ONLY indexes NYC addresses. That property is load-bearing: it
# is our authoritative "is this NYC" gate. An address it can't resolve is,
# for our purposes, not a usable NYC address -- and maps to the honest "not
# available" state, never a fabricated location.
# ---------------------------------------------------------------------------

GEOSEARCH_URL = "https://geosearch.planninglabs.nyc/v2/search"

NYC_BBOX = {"min_lat": 40.4774, "max_lat": 40.9176, "min_lng": -74.2591, "max_lng": -73.7004}
"""WGS84 bounding box for the five boroughs (generous, incl. Staten Island)."""


def is_within_nyc(lat: float, lng: float) -> bool:
    """True if a lat/lng falls inside the NYC bounding box."""
    return (
        NYC_BBOX["min_lat"] <= lat <= NYC_BBOX["max_lat"]
        and NYC_BBOX["min_lng"] <= lng <= NYC_BBOX["max_lng"]
    )


class GeocodeError(Exception):
    def __init__(self, message: str, kind: models.UnavailableReason):
        super().__init__(message)
        self.message = message
        self.kind = kind


# How many times to ask before concluding the service is down. Three
# attempts over ~1s. GeoSearch sits behind a load balancer that returns 503
# with no body when it has no healthy backend, and a single unlucky request
# hitting a rolling restart used to be indistinguishable from an outage.
# Only transport-level trouble is retried: asking a healthy service the same
# unanswerable question three times is just three times the wait.
_ATTEMPTS = 3
_BACKOFF_S = [0.2, 0.7]


async def geocode_address(address: str) -> models.GeocodeResult:
    """Geocode a NYC address. Raises GeocodeError with a discriminating
    `kind` on any failure so the pipeline can route every branch to the
    honest unavailable state."""
    last: GeocodeError | None = None
    for attempt in range(_ATTEMPTS):
        try:
            return await _geocode_once(address)
        except GeocodeError as err:
            if err.kind != "network-error":
                raise
            last = err
            if attempt >= len(_BACKOFF_S):
                break
            await asyncio.sleep(_BACKOFF_S[attempt])
    raise last or GeocodeError("Could not reach the NYC address service.", "network-error")


async def _geocode_once(address: str) -> models.GeocodeResult:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.get(GEOSEARCH_URL, params={"text": address, "size": 1})
    except httpx.HTTPError:
        raise GeocodeError("Could not reach the NYC address service.", "network-error")

    if res.status_code != 200:
        raise GeocodeError(f"Address service returned {res.status_code}.", "network-error")

    try:
        data: dict[str, Any] = res.json()
    except ValueError:
        raise GeocodeError("Malformed response from address service.", "network-error")

    features = data.get("features") or []
    feature = features[0] if features else None
    if not feature:
        raise GeocodeError("We couldn't find that address in NYC.", "geocode-failed")

    lng, lat = feature["geometry"]["coordinates"]
    props = feature.get("properties") or {}

    # GeoSearch is NYC-only, but guard the bbox too: a bad match outside NYC
    # is treated as "not NYC" rather than silently accepted.
    if not is_within_nyc(lat, lng):
        raise GeocodeError("That address resolved outside New York City.", "not-nyc")

    # Pelias always answers with *something*. Verify that the something it
    # found is the address that was typed -- see verify_address_match below
    # for why this is not optional. A silent fuzzy substitution would render
    # real imagery of the wrong building under the user's address, which is
    # a worse lie than a missing image.
    parsed_text = ((data.get("geocoding") or {}).get("query") or {}).get("parsed_text") or {}
    verdict = verify_address_match(
        parsed_text,
        {
            "housenumber": props.get("housenumber"),
            "street": props.get("street"),
            "locality": props.get("locality"),
            "borough": props.get("borough"),
            "region_a": props.get("region_a"),
            "label": props.get("label"),
        },
    )
    if not verdict["ok"]:
        raise GeocodeError(verdict["message"], verdict["kind"])

    bin_raw = ((props.get("addendum") or {}).get("pad") or {}).get("bin")
    bin_ = str(bin_raw).strip() if bin_raw is not None and str(bin_raw).strip() != "" else None

    return models.GeocodeResult(
        label=props.get("label") or props.get("name") or address,
        lat=lat,
        lng=lng,
        bin=bin_,
        borough=props.get("borough"),
    )


# ---------------------------------------------------------------------------
# Verify that the geocoder actually found the address the user typed.
#
# WHY THIS EXISTS (this was a real, product-breaking bug):
#
# NYC Planning's GeoSearch is a Pelias instance. Pelias always returns its
# best candidate; for an address it cannot resolve it falls back to a fuzzy
# match and still reports confidence: 0.8, match_type: "fallback" -- the
# SAME values it reports for a perfect hit. Measured against the live
# service on 2026-08-04:
#
#   "1 Infinite Loop, Cupertino, CA"  -> 1 ASH LOOP, Bronx, NY
#   "123 Fake Street, Brooklyn, NY"   -> 123 SCHERMERHORN STREET, Brooklyn, NY
#   "77777 Imaginary Ave, Queens, NY" -> 77777 SPRINGFIELD AVENUE, Queens, NY
#   "10 Downing Street, London"       -> 10 DOWNING STREET, New York, NY
#
# The app then rendered *real* imagery of a *different building* and
# captioned it with the user's address. Neither confidence nor match_type
# can separate these cases, so this compares the geocoder's own parse of the
# query against the properties of the feature it returned, and refuses
# anything that doesn't line up. Refusal is routed to the same honest "not
# available" state as every other failure -- never to a substituted
# location.
# ---------------------------------------------------------------------------

_ABBREVIATIONS = {
    "ST": "STREET", "STR": "STREET", "AVE": "AVENUE", "AV": "AVENUE",
    "BLVD": "BOULEVARD", "BLV": "BOULEVARD", "RD": "ROAD", "DR": "DRIVE",
    "PL": "PLACE", "PLZ": "PLAZA", "PKWY": "PARKWAY", "PKY": "PARKWAY",
    "LN": "LANE", "CT": "COURT", "TER": "TERRACE", "TERR": "TERRACE",
    "SQ": "SQUARE", "HWY": "HIGHWAY", "EXPY": "EXPRESSWAY", "CIR": "CIRCLE",
    "N": "NORTH", "S": "SOUTH", "E": "EAST", "W": "WEST",
    "NE": "NORTHEAST", "NW": "NORTHWEST", "SE": "SOUTHEAST", "SW": "SOUTHWEST",
}
"""Street-type and directional abbreviations seen in NYC address input."""

_NYC_LOCALITIES = {
    "NEW YORK", "NEW YORK CITY", "NYC", "MANHATTAN", "BROOKLYN", "QUEENS",
    "BRONX", "THE BRONX", "STATEN ISLAND",
}
"""Localities that are unambiguously within the five boroughs."""

_ORDINAL_RE = re.compile(r"^(\d+)(ST|ND|RD|TH)$")


def normalize_street(street: str) -> list[str]:
    """Canonical tokens for a street name: uppercase, punctuation stripped,
    abbreviations expanded, ordinal suffixes removed ("5TH" -> "5", "72ND"
    -> "72"). "W 72nd St" and "WEST 72 STREET" both normalize to
    ["WEST", "72", "STREET"]."""
    cleaned = re.sub(r"[.,#]", " ", street.upper())
    tokens = [t for t in cleaned.split() if t]
    tokens = [_ORDINAL_RE.sub(r"\1", t) for t in tokens]
    return [_ABBREVIATIONS.get(t, t) for t in tokens]


def normalize_house_number(hn: str) -> str:
    """Normalize a house number for comparison ("89-14" and "89-14" only)."""
    return re.sub(r"^0+(?=\d)", "", re.sub(r"\s+", "", hn.upper()))


def verify_address_match(parsed: dict[str, Any], matched: dict[str, Any]) -> dict[str, Any]:
    """Decide whether a GeoSearch result really is the address that was
    typed.

    Check order matters, and it is not the obvious one:
      1. region (state) -- a non-NY state in the query is positive evidence
         the user meant somewhere else entirely.
      2. house number + street -- must match after normalization. This is
         the check that catches the fuzzy street fallback.
      3. locality (city) -- LAST, on purpose.

    Why locality is checked last (fixed 2026-08-04, found by the mismatch
    proof harness): an unrecognised locality alone does not tell you the
    address is outside NYC. "31-45 45th St, Astoria" is matched by
    GeoSearch to "45-31 45 STREET, Sunnyside" -- a transposed house number.
    Checking locality first produced "That address looks like it's in
    Astoria. 27B only covers New York City.", which is false: Astoria is in
    Queens. The real problem was the house number, and the honest message
    is "we couldn't find that exact address".

    Running the number/street check first means that by the time the
    locality check runs, we know the house number and street DID match --
    so the city is the only discrepancy, and "you probably meant a
    different city" is a conclusion we have actually earned. The general
    rule: only claim an address is outside NYC on positive evidence (a
    non-NY state, or an otherwise-exact match in a city the user didn't
    name). Otherwise say what is certainly true -- we could not verify the
    address.

    Returns {"ok": True} or {"ok": False, "kind": ..., "message": ...}.
    """

    def not_nyc(what: str) -> dict[str, Any]:
        return {
            "ok": False,
            "kind": "not-nyc",
            "message": f"That address looks like it's in {what}. 27B only covers New York City.",
        }

    not_found = {
        "ok": False,
        "kind": "geocode-failed",
        "message": "We couldn't find that exact address in New York City. Check the street name and try again.",
    }

    region = (parsed.get("region") or "").strip().upper()
    if region and region not in ("NY", "NEW YORK"):
        return not_nyc((parsed.get("region") or "").strip())

    # Without a parsed street there is nothing to verify against, and an
    # unverified match is exactly the failure mode this exists to stop.
    if not parsed.get("street") or not matched.get("street"):
        return not_found

    if parsed.get("housenumber") and matched.get("housenumber"):
        if normalize_house_number(parsed["housenumber"]) != normalize_house_number(matched["housenumber"]):
            return not_found

    want = normalize_street(parsed["street"])
    got = normalize_street(matched["street"])
    if want != got:
        return not_found

    # House number and street both matched exactly. So if the city the user
    # named is one we can't place in NYC and the matched result doesn't
    # corroborate it, the city is the ONLY thing that disagrees -- which is
    # the one situation where "you meant a different city" is a supportable
    # conclusion rather than a guess.
    locality = (parsed.get("locality") or "").strip().upper()
    if locality and locality not in _NYC_LOCALITIES:
        label = (matched.get("label") or "").upper()
        in_label = locality in label
        is_borough = (matched.get("borough") or "").upper() == locality
        is_matched_locality = (matched.get("locality") or "").upper() == locality
        if not (in_label or is_borough or is_matched_locality):
            return not_nyc((parsed.get("locality") or "").strip())

    return {"ok": True}


# ---------------------------------------------------------------------------
# Building height + ground elevation via NYC Open Data Building Footprints.
#
# Source: NYC Building Footprints on the Socrata Open Data API (SODA),
# dataset id 5zhs-2jue, a free, key-less endpoint. Vertical datum note: the
# published elevations are referenced to NAVD88 ("Based on the North
# American Vertical Datum of 1988") -- NOT WGS84 ellipsoidal heights;
# geometry.py's geoid_height_m does that conversion.
#
# If a record is missing or lacks usable height, we surface "no-footprint"
# -> the honest unavailable state, never a guessed building. Footprint data
# is GEOMETRY, not provider pixels, and this app makes no attempt to cache
# it -- unnecessary at this scale.
# ---------------------------------------------------------------------------

SODA_URL = "https://data.cityofnewyork.us/resource/5zhs-2jue.json"
FEET_TO_METERS = 0.3048
"""The dataset publishes heights in US survey feet; everything downstream
of this module is metric."""

_BIN_RE = re.compile(r"^\d{1,10}$")


class FootprintError(Exception):
    def __init__(self, message: str, kind: models.UnavailableReason):
        super().__init__(message)
        self.message = message
        self.kind = kind


def _first_ring(geom: dict[str, Any] | None) -> geometry.Ring | None:
    """Outer ring ([lng, lat] pairs) of a SODA Polygon or MultiPolygon, or
    None. For a Polygon that is coordinates[0]; for a MultiPolygon, the
    first polygon's outer ring at coordinates[0][0]. Rings of fewer than
    three points are rejected: they have no area, so a centroid or a facade
    raycast taken from one is meaningless rather than merely imprecise."""
    if not geom:
        return None
    coords = geom.get("coordinates")
    if not isinstance(coords, list):
        return None
    ring = coords[0][0] if geom.get("type") == "MultiPolygon" else coords[0]
    if not isinstance(ring, list) or len(ring) < 3:
        return None
    if not isinstance(ring[0], list) or len(ring[0]) < 2:
        return None
    return [(float(p[0]), float(p[1])) for p in ring]


def _num(v: str | None) -> float | None:
    """Parse a numeric SODA field that may arrive as a string, or be absent."""
    if v is None:
        return None
    try:
        n = float(v)
    except ValueError:
        return None
    return n if n == n and n not in (float("inf"), float("-inf")) else None  # NaN/inf guard


def parse_footprint(row: dict[str, Any], bin: str) -> geometry.Footprint:
    """Convert a raw SODA row into a geometry.Footprint (meters). Exported
    for unit tests -- the ft->m conversion and the "missing height =>
    no-footprint" rule are exactly the kind of logic that must be proven,
    not trusted."""
    roof_ft = _num(row.get("height_roof"))
    ground_ft = _num(row.get("ground_elevation"))

    # A footprint with no usable roof height can't place a floor camera.
    # Refuse rather than invent a height.
    if roof_ft is None or roof_ft <= 0:
        raise FootprintError(
            "This building has no height on file, so we can't place the view.",
            "no-footprint",
        )

    ring = _first_ring(row.get("the_geom"))
    if not ring:
        raise FootprintError("This building's footprint shape is missing.", "no-footprint")

    return geometry.Footprint(
        bin=row.get("bin") or bin,
        roof_height_m=roof_ft * FEET_TO_METERS,
        # ground_elevation can legitimately be ~0 near the waterline;
        # default 0. This is an NAVD88 ORTHOMETRIC height, not an
        # ellipsoidal one -- see geometry.py's geoid conversion.
        ground_elevation_navd88_m=(ground_ft or 0) * FEET_TO_METERS,
        centroid=geometry.polygon_centroid(ring),
        ring=ring,
    )


async def fetch_footprint_by_bin(bin: str) -> geometry.Footprint:
    """Fetch a building footprint by BIN. Raises FootprintError with a
    discriminating `kind` so the pipeline routes both "no record" and
    "service down" to the honest unavailable state."""
    # `bin` is provider-supplied (the geocoder's join key), not raw user
    # input, but validating its known shape (NYC BINs are a 7-digit numeric
    # string) before it reaches the query string costs nothing and closes
    # the gap regardless of where the value came from.
    if not _BIN_RE.match(bin):
        raise FootprintError(f'Malformed BIN: "{bin}"', "network-error")

    where = f"bin='{bin}'"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.get(SODA_URL, params={"$where": where, "$limit": 1})
    except httpx.HTTPError:
        raise FootprintError("Could not reach the NYC building-data service.", "network-error")

    if res.status_code != 200:
        raise FootprintError(f"Building-data service returned {res.status_code}.", "network-error")

    try:
        rows: list[dict[str, Any]] = res.json()
    except ValueError:
        raise FootprintError("Malformed response from building-data service.", "network-error")

    row = rows[0] if rows else None
    if not row:
        raise FootprintError("No building footprint on file for this address yet.", "no-footprint")

    return parse_footprint(row, bin)


# ---------------------------------------------------------------------------
# Orchestration: (address, floor) -> ViewPlanResponse
# ---------------------------------------------------------------------------

GeocodeFn = Callable[[str], Awaitable[models.GeocodeResult]]
FetchFootprintFn = Callable[[str], Awaitable[geometry.Footprint]]


def _unavailable(
    reason: models.UnavailableReason,
    message: str,
    supported_floors: models.SupportedFloors | None = None,
) -> models.ViewPlanResponse:
    return models.ViewPlanResponse(ok=False, reason=reason, message=message, supported_floors=supported_floors)


async def plan_view(
    address: str,
    floor: int,
    *,
    geocode: GeocodeFn = geocode_address,
    fetch_footprint: FetchFootprintFn = fetch_footprint_by_bin,
) -> models.ViewPlanResponse:
    """Produce a ViewPlan for an address + floor, or an honest unavailable
    result. `address` and `floor` are assumed already validated by the
    frontend form. `geocode`/`fetch_footprint` are injectable so the
    pipeline is unit-testable without network -- see tests/test_planning.py."""
    started = time.monotonic()

    try:
        # 1. Geocode (NYC-only service doubles as the NYC gate) and verify
        #    the result really is the typed address (verify_address_match).
        geo = await geocode(address)

        if not geo.bin:
            # No BIN means we can't join to a building footprint. Honest fail.
            return _unavailable(
                "no-footprint",
                "We found the address but not a specific building record for it yet.",
            )

        # 2. Curated gate. A real, verified NYC address that isn't on the
        #    supported list is a NOT-SUPPORTED result, stated plainly -- the
        #    mesh quality ceiling is the provider's, and we don't show
        #    broken frames.
        curated = curated_by_bin(geo.bin)
        if not curated:
            return _unavailable(
                "not-supported",
                f"{geo.label} is a real address, but it isn't one of the buildings we've verified renders well.",
            )
        if floor < curated.floors.min or floor > curated.floors.max:
            return _unavailable(
                "not-supported",
                f"At {curated.name} we've only verified good views from floors {curated.floors.min}-{curated.floors.max}.",
                curated.floors,
            )

        # 3. Footprint height + centroid (NYC Open Data -- geometry, keyless).
        footprint = await fetch_footprint(geo.bin)

        # 4. Geometry math (pure, real): elevation in both datums + four
        #    cameras aimed along the building's own facades where the
        #    footprint supports it.
        elevation = geometry.estimate_floor_elevation(footprint, floor)
        eye_above_ground_m = elevation.eye_elevation_navd88_m - footprint.ground_elevation_navd88_m
        cam = geometry.build_camera_views(
            footprint, elevation.eye_elevation_ellipsoidal_m, eye_above_ground_m
        )

        plan = models.ViewPlan(
            address=address,
            floor=floor,
            geocode=geo,
            footprint=models.FootprintSummary(
                bin=footprint.bin,
                roof_height_m=footprint.roof_height_m,
                ground_elevation_navd88_m=footprint.ground_elevation_navd88_m,
                centroid=models.LatLng(lat=footprint.centroid[0], lng=footprint.centroid[1]),
            ),
            curated_name=curated.name,
            eye_elevation_navd88_m=elevation.eye_elevation_navd88_m,
            eye_elevation_ellipsoidal_m=elevation.eye_elevation_ellipsoidal_m,
            geoid_height_m=elevation.geoid_height_m,
            floor_clamped_to_roof=elevation.clamped_to_roof,
            basis=cam.basis,
            views=[
                models.CameraView(
                    slot=v.slot,
                    heading_deg=v.heading_deg,
                    compass=v.compass,
                    lat=v.lat,
                    lng=v.lng,
                    height_m=v.height_m,
                    pitch_deg=v.pitch_deg,
                    standoff_m=v.standoff_m,
                )
                for v in cam.views
            ],
        )

        # Draft instrumentation, console-only: the geometry half is expected
        # to resolve in ~1s (two keyless HTTP calls + pure math).
        print(f"[27b] plan resolved in {(time.monotonic() - started) * 1000:.0f} ms")
        return models.ViewPlanResponse(ok=True, plan=plan)

    except GeocodeError as err:
        return _unavailable(err.kind, err.message)
    except FootprintError as err:
        return _unavailable(err.kind, err.message)
    except Exception:
        # Unknown error: still honest, never a fake scene. Mirrors the
        # pre-migration TS catch-all -- see main.py for the one place this
        # can still surface as a real 5xx (a bug in this function itself,
        # not a modeled domain outcome).
        return _unavailable(
            "network-error",
            "Something went wrong resolving this address. Please try again.",
        )
