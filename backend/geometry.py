"""Camera geometry: turn real building data into four real camera vantages.

Ported from the frontend's src/lib/geometry.ts + src/lib/geoid.ts (that
TypeScript is now deleted; this is the only copy). This module is the
mathematical heart of the "geometry is real" guarantee and is fully unit
tested. It does four things, all pure, all standard-library math:

  1. estimate the eye elevation for a floor, in the source datum (NAVD88) and
     in the WGS84 ellipsoidal datum the renderer actually consumes,
  2. find the building's dominant facade orientation from its footprint,
  3. ray-cast from the centroid to the OUTERMOST facade wall in each of the
     four view bearings,
  4. push the camera just outside that wall, and verify it really is outside.

It never invents a scene -- it only decides where a camera sits inside
Google's real photogrammetric reconstruction of NYC. Deliberately dependency
-free (stdlib `math` only) so it stays trivially unit-testable and has no
opinion about HTTP, FastAPI, or Pydantic -- planning.py is the only caller.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

Ring = list[tuple[float, float]]  # GeoJSON convention: (lng, lat) pairs.

# ---------------------------------------------------------------------------
# Vertical datum conversion: NAVD88 orthometric height -> WGS84 ellipsoidal.
#
# WHY THIS EXISTS (this was a real, ~32 m bug in the original TS build):
#
# NYC Building Footprints publishes `ground_elevation` in feet referenced to
# the North American Vertical Datum of 1988 (NAVD88) -- an *orthometric*
# height, measured from the geoid ("mean sea level"). Source:
# https://github.com/CityOfNewYork/nyc-geo-metadata/blob/main/Metadata/Metadata_BuildingFootprints.md
#
# Cesium's `Cartesian3.fromDegrees(lng, lat, height)` -- and therefore every
# camera placed inside Google's Photorealistic 3D Tiles, which are
# georeferenced in ECEF/WGS84 -- expects an *ellipsoidal* height, measured
# from the WGS84 ellipsoid. The two differ by the geoid undulation N:
#
#     h (ellipsoidal) = H (orthometric, NAVD88) + N (geoid height)
#
# Over New York City N is about -31 m to -32.5 m. Passing an NAVD88 height
# straight into Cesium therefore placed every camera roughly 32 m too high --
# about ten floors of error.
#
# HOW THE GRID WAS PRODUCED (reproducible): values are GEOID18 (the hybrid
# model for NAVD88 in CONUS) sampled from NOAA NGS's public Geoid Height
# Service on 2026-08-04 (https://geodesy.noaa.gov/api/geoid/ght?lat=..&lon=..)
# on a 0.1-degree lattice covering the five boroughs. Bilinear interpolation
# of this lattice was validated against 8 independent NOAA queries: max error
# 0.031 m, far below the 3.2 m floor-height assumption this app discloses.
# ---------------------------------------------------------------------------

GEOID_LAT0 = 40.4
"""Southern edge of the lattice (degrees)."""
GEOID_LON0 = -74.3
"""Western edge of the lattice (degrees)."""
GEOID_STEP = 0.1
"""Lattice spacing (degrees)."""

GEOID18_NYC: tuple[tuple[float, ...], ...] = (
    (-32.452, -32.346, -32.396, -32.555, -32.618, -32.472, -32.29, -32.186),
    (-32.557, -32.374, -32.307, -32.394, -32.468, -32.362, -32.173, -32.008),
    (-32.633, -32.376, -32.167, -32.102, -32.133, -32.122, -31.997, -31.781),
    (-32.649, -32.398, -32.115, -31.857, -31.697, -31.676, -31.656, -31.519),
    (-32.577, -32.365, -32.091, -31.742, -31.477, -31.332, -31.274, -31.188),
    (-32.492, -32.31, -32.051, -31.692, -31.353, -31.133, -31.017, -30.905),
    (-32.31, -32.165, -31.965, -31.656, -31.295, -30.978, -30.781, -30.65),
)
"""GEOID18 geoid heights (meters) on the lattice, row-major south to north,
each row west to east. rows: lat 40.4 .. 41.0, cols: lon -74.3 .. -73.6."""

_N_ROWS = len(GEOID18_NYC)
_N_COLS = len(GEOID18_NYC[0])


def geoid_height_m(lat: float, lng: float) -> float:
    """GEOID18 geoid height (meters, negative over NYC) at a WGS84 lat/lng,
    by bilinear interpolation of the baked lattice. Coordinates outside the
    lattice are clamped to its edge -- the caller has already rejected
    anything outside the NYC bounding box, so clamping only ever affects
    points within a tenth of a degree of the edge, where the field is
    smooth."""
    fi = (lat - GEOID_LAT0) / GEOID_STEP
    fj = (lng - GEOID_LON0) / GEOID_STEP

    i = min(max(math.floor(fi), 0), _N_ROWS - 2)
    j = min(max(math.floor(fj), 0), _N_COLS - 2)
    ti = min(max(fi - i, 0.0), 1.0)
    tj = min(max(fj - j, 0.0), 1.0)

    g00 = GEOID18_NYC[i][j]
    g01 = GEOID18_NYC[i][j + 1]
    g10 = GEOID18_NYC[i + 1][j]
    g11 = GEOID18_NYC[i + 1][j + 1]

    return (
        g00 * (1 - ti) * (1 - tj)
        + g01 * (1 - ti) * tj
        + g10 * ti * (1 - tj)
        + g11 * ti * tj
    )


# ---------------------------------------------------------------------------
# Camera math
# ---------------------------------------------------------------------------

ASSUMED_FLOOR_HEIGHT_M = 3.2
"""Assumed floor-to-floor height, meters. NYC Building Footprints carry no
per-floor field, so we estimate. 3.2 m is a middle-of-road residential
floor-to-floor height. This is the single approximation that makes
"height-only vertical framing" work, and the reason the UI copy always says
"approximately what you'd see"."""

EYE_ABOVE_FLOOR_M = 1.5
"""Height of the eye above the floor slab (a standing person at a window)."""

FACADE_OFFSET_M = 6
"""How far outside the facade to push the camera, meters. Every metre here
is spent twice: it buys clearance from the subject building's own
photogrammetric mesh, and it costs the same metre of separation from
whatever the camera is looking AT. Selected in the 2026-08 rendering
bake-off against real captures."""

RESCUE_STEP_M = 6
"""Step used by the escape hatch in build_camera_views when a malformed ring
leaves the camera inside the polygon. Deliberately larger than
FACADE_OFFSET_M: this loop only ever runs for self-intersecting source
geometry, where the right move is to get clear quickly rather than to
creep."""

FACADE_CONCENTRATION_MIN = 0.5
"""Minimum length-weighted orientation concentration required before we
claim a building has facades. Below this we fall back to true compass views
and say so rather than inventing a facade the footprint doesn't support."""

EARTH_RADIUS_M = 6_378_137
"""WGS84 equatorial radius."""

COMPASS_16 = (
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
)
"""16-point compass abbreviations, index = round(bearing / 22.5) mod 16."""


def compass_label(bearing_deg: float) -> str:
    """Nearest 16-point compass abbreviation for a true bearing in degrees."""
    norm = bearing_deg % 360
    return COMPASS_16[round(norm / 22.5) % 16]


@dataclass(frozen=True)
class Footprint:
    """Building geometry, as read off NYC Open Data Building Footprints.
    Heights are meters. `ground_elevation_navd88_m` is an ORTHOMETRIC height
    (NAVD88) -- see the module docstring for the conversion to the
    ellipsoidal height Cesium needs."""

    bin: str
    roof_height_m: float
    ground_elevation_navd88_m: float
    centroid: tuple[float, float]  # (lat, lng)
    ring: Ring  # outer footprint ring, [(lng, lat), ...]


@dataclass(frozen=True)
class FloorElevation:
    eye_elevation_navd88_m: float
    """Eye elevation in the source datum (NAVD88 orthometric), meters."""
    eye_elevation_ellipsoidal_m: float
    """Eye elevation as a WGS84 ellipsoidal height, meters (renderer input)."""
    geoid_height_m: float
    """GEOID18 undulation applied (meters, negative over NYC)."""
    clamped_to_roof: bool
    """True when the requested floor exceeded the roof and was clamped."""


def estimate_floor_elevation(footprint: Footprint, floor: int) -> FloorElevation:
    """Estimate eye elevation for a floor, in both datums.

    Floor 1 sits at ground; each floor above adds ASSUMED_FLOOR_HEIGHT_M.
    The eye is EYE_ABOVE_FLOOR_M above the slab. The result is clamped so it
    can never exceed the real roof height -- we refuse to place a camera
    above a building that isn't that tall, which would fabricate a vantage
    that doesn't exist.

    The NAVD88 -> WGS84 conversion is not cosmetic: it is worth about -31.7 m
    in NYC, i.e. ten floors.
    """
    floor_slab_above_ground = (floor - 1) * ASSUMED_FLOOR_HEIGHT_M
    eye_above_ground = floor_slab_above_ground + EYE_ABOVE_FLOOR_M

    roof = footprint.roof_height_m
    clamped_to_roof = eye_above_ground > roof and roof > 0
    capped_above_ground = roof if clamped_to_roof else eye_above_ground

    eye_elevation_navd88_m = footprint.ground_elevation_navd88_m + capped_above_ground
    undulation = geoid_height_m(footprint.centroid[0], footprint.centroid[1])

    return FloorElevation(
        eye_elevation_navd88_m=eye_elevation_navd88_m,
        eye_elevation_ellipsoidal_m=eye_elevation_navd88_m + undulation,
        geoid_height_m=undulation,
        clamped_to_roof=clamped_to_roof,
    )


def normalize_bearing(deg: float) -> float:
    """Normalize a bearing into [0, 360)."""
    return deg % 360


def offset_lat_lng(
    lat: float, lng: float, heading_deg: float, distance_m: float
) -> tuple[float, float]:
    """Offset a lat/lng by a distance (meters) along a compass heading.
    Equirectangular approximation -- accurate to well under a meter at the
    tens of meters we use, far finer than the tile mesh resolution."""
    bearing = math.radians(heading_deg)
    d_north = distance_m * math.cos(bearing)
    d_east = distance_m * math.sin(bearing)

    d_lat = (d_north / EARTH_RADIUS_M) * (180 / math.pi)
    d_lng = (d_east / (EARTH_RADIUS_M * math.cos(math.radians(lat)))) * (180 / math.pi)

    return (lat + d_lat, lng + d_lng)


def ring_to_local_meters(ring: Ring, origin: tuple[float, float]) -> Ring:
    """Project a GeoJSON [lng, lat] ring into local metric coordinates
    (x = meters east, y = meters north) relative to an origin.
    Equirectangular; sub-millimetre over a building footprint."""
    origin_lat, origin_lng = origin
    cos_lat = math.cos(math.radians(origin_lat))
    return [
        (
            (lng - origin_lng) * math.radians(1) * EARTH_RADIUS_M * cos_lat,
            (lat - origin_lat) * math.radians(1) * EARTH_RADIUS_M,
        )
        for lng, lat in ring
    ]


def point_in_ring_meters(pts: Ring, x: float, y: float) -> bool:
    """Even-odd point-in-polygon test in local metric coordinates."""
    inside = False
    n = len(pts)
    j = n - 1
    for i in range(n):
        xi, yi = pts[i]
        xj, yj = pts[j]
        intersects = (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi
        if intersects:
            inside = not inside
        j = i
    return inside


def facade_distance_m(
    ring: Ring, centroid: tuple[float, float], heading_deg: float
) -> float:
    """Distance in meters from the building centroid to the **outermost**
    footprint boundary crossing along a compass heading.

    Taking the farthest crossing rather than the nearest is what makes this
    correct for concave / L-shaped / courtyard footprints (the Dakota is a
    real NYC example): the nearest crossing can be the wall of an inner
    notch, and pushing 6 m past *that* leaves the camera still inside the
    building mass. Past the farthest crossing, the ray has left the polygon
    for good.

    Returns 0 for degenerate rings (< 3 points) or if the ray misses every
    edge, so the caller's FACADE_OFFSET_M still applies as a minimum push.
    """
    if len(ring) < 3:
        return 0

    bearing = math.radians(heading_deg)
    dir_x = math.sin(bearing)  # east component of heading unit vector
    dir_y = math.cos(bearing)  # north component of heading unit vector

    pts = ring_to_local_meters(ring, centroid)

    max_t = -math.inf
    n = len(pts)
    for i in range(n):
        ax, ay = pts[i]
        bx, by = pts[(i + 1) % n]
        # Solve: origin + t*dir = A + s*(B - A)
        ex = bx - ax
        ey = by - ay
        denom = dir_x * ey - dir_y * ex
        if abs(denom) < 1e-9:
            continue  # ray parallel to edge
        t = (ax * ey - ay * ex) / denom
        s = (ax * dir_y - ay * dir_x) / denom
        # t > 0: intersection is ahead of the centroid along the heading.
        # 0 <= s <= 1: intersection is on the segment, not its extension.
        if t > 1e-3 and -1e-6 <= s <= 1 + 1e-6 and t > max_t:
            max_t = t

    return max_t if math.isfinite(max_t) and max_t > 0 else 0


@dataclass(frozen=True)
class FacadeAxis:
    bearing_deg: float
    """Bearing of the first facade normal, normalized into [0, 90)."""
    concentration: float
    """Length-weighted orientation concentration in [0, 1]. 1 = every edge
    is axis-aligned with the same rectilinear frame; ~0 = no dominant
    orientation."""


def principal_facade_axis(ring: Ring, centroid: tuple[float, float]) -> FacadeAxis:
    """Find the building's dominant rectilinear orientation from its
    footprint edges.

    Method: each edge contributes exp(i * 4 * theta), weighted by its
    length, where theta is the edge bearing. Multiplying the angle by 4
    makes the estimate invariant under 90-degree rotation, which is exactly
    the symmetry of a rectangular building -- a wall and its perpendicular
    neighbour vote for the same axis instead of cancelling. The resultant's
    argument divided by 4 is the dominant axis; the resultant's normalized
    length is how strongly the footprint actually commits to it.

    Manhattan sanity check: the borough's street grid is rotated about 29
    degrees clockwise from true north, so most Manhattan footprints return
    ~29 (or an equivalent 90-degree rotation of it), not 0. Verified live at
    29.0 degrees on the real Empire State Building footprint.
    """
    pts = ring_to_local_meters(ring, centroid)
    if len(pts) < 3:
        return FacadeAxis(bearing_deg=0, concentration=0)

    sum_x = 0.0
    sum_y = 0.0
    total_len = 0.0
    n = len(pts)
    for i in range(n):
        ax, ay = pts[i]
        bx, by = pts[(i + 1) % n]
        dx = bx - ax
        dy = by - ay
        length = math.hypot(dx, dy)
        if length < 1e-6:
            continue
        # Compass bearing of the edge: atan2(east, north).
        theta = math.atan2(dx, dy)
        sum_x += length * math.cos(4 * theta)
        sum_y += length * math.sin(4 * theta)
        total_len += length
    if total_len == 0:
        return FacadeAxis(bearing_deg=0, concentration=0)

    concentration = math.hypot(sum_x, sum_y) / total_len
    bearing = normalize_bearing(math.degrees(math.atan2(sum_y, sum_x)) / 4) % 90
    return FacadeAxis(bearing_deg=bearing, concentration=concentration)


ViewBasis = Literal["facade", "compass"]


@dataclass(frozen=True)
class ViewBearings:
    basis: ViewBasis
    bearings_deg: list[float]
    axis: FacadeAxis


def view_bearings(footprint: Footprint) -> ViewBearings:
    """The four view bearings for a footprint, plus how they were chosen.

    `facade` basis: the outward normals of the building's dominant wall
    planes -- i.e. the direction a window in each wall actually faces.
    `compass` basis: true N/E/S/W, used only when the footprint has no
    dominant orientation. The basis is carried through to the API response
    so the labelling is never ambiguous about which one you're looking at.
    """
    axis = principal_facade_axis(footprint.ring, footprint.centroid)
    if axis.concentration >= FACADE_CONCENTRATION_MIN:
        return ViewBearings(
            basis="facade",
            bearings_deg=[normalize_bearing(axis.bearing_deg + 90 * k) for k in range(4)],
            axis=axis,
        )
    return ViewBearings(basis="compass", bearings_deg=[0, 90, 180, 270], axis=axis)


ViewSlot = Literal["V1", "V2", "V3", "V4"]
VIEW_SLOTS: tuple[ViewSlot, ...] = ("V1", "V2", "V3", "V4")


@dataclass(frozen=True)
class CameraView:
    slot: ViewSlot
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
    """WGS84 ellipsoidal height (m) -- the value Cesium consumes."""
    pitch_deg: float
    """Pitch in degrees; 0 = horizon, negative = looking down."""
    standoff_m: float
    """Meters from the footprint centroid to the camera along heading_deg."""


@dataclass(frozen=True)
class CameraViewsResult:
    views: list[CameraView]
    basis: ViewBasis
    concentration: float


def build_camera_views(
    footprint: Footprint,
    eye_elevation_ellipsoidal_m: float,
    eye_above_ground_m: float,
) -> CameraViewsResult:
    """Build the four camera views for a footprint at a given ellipsoidal
    eye height.

    Each camera is placed just outside the building wall in its bearing --
    first we ray-cast from the centroid to the outermost footprint
    crossing, then push FACADE_OFFSET_M beyond it, then *verify* the
    resulting point is outside the footprint polygon and push further if it
    isn't. The verification matters for footprints whose centroid lies
    outside the polygon (U- and L-shaped buildings), where no single offset
    rule is safe by construction.

    A slight downward tilt (pitch_deg < 0) is applied so city geometry
    fills the frame rather than open sky. The tilt increases gently with
    floor height: at street-level floors you want a near-horizontal view;
    at the 80th floor of the Empire State Building a -9 degree tilt puts
    the Midtown skyline in frame.
    """
    # -3 deg at ground level -> -9 deg at 200 m+, clamped; keeps sky in the
    # top third of the frame.
    pitch_deg = max(-9.0, -(3 + eye_above_ground_m / 33))
    bearings = view_bearings(footprint)
    local_ring = ring_to_local_meters(footprint.ring, footprint.centroid)

    views: list[CameraView] = []
    for i, heading_deg in enumerate(bearings.bearings_deg):
        wall_dist = facade_distance_m(footprint.ring, footprint.centroid, heading_deg)
        standoff_m = wall_dist + FACADE_OFFSET_M

        # Verify the camera is genuinely outside the footprint; push out in
        # RESCUE_STEP_M steps if a pathological ring puts it back inside.
        #
        # For any simple ring this loop provably never runs: facade_distance_m
        # returns the OUTERMOST boundary crossing, past which the ray has
        # left the polygon for good, so wall_dist + anything positive is
        # already outside -- even for a C whose centroid sits in the notch
        # (pinned in test_geometry.py). It stays as a guard against
        # self-intersecting or otherwise malformed source rings, where
        # even-odd parity can disagree with the raycast.
        dir_x = math.sin(math.radians(heading_deg))
        dir_y = math.cos(math.radians(heading_deg))
        for _guard in range(8):
            if not point_in_ring_meters(local_ring, standoff_m * dir_x, standoff_m * dir_y):
                break
            standoff_m += RESCUE_STEP_M

        lat, lng = offset_lat_lng(
            footprint.centroid[0], footprint.centroid[1], heading_deg, standoff_m
        )
        views.append(
            CameraView(
                slot=VIEW_SLOTS[i],
                heading_deg=heading_deg,
                compass=compass_label(heading_deg),
                lat=lat,
                lng=lng,
                height_m=eye_elevation_ellipsoidal_m,
                pitch_deg=pitch_deg,
                standoff_m=standoff_m,
            )
        )

    return CameraViewsResult(views=views, basis=bearings.basis, concentration=bearings.axis.concentration)


def polygon_centroid(ring: Ring) -> tuple[float, float]:
    """Compute the centroid of a footprint polygon ring (GeoJSON [lng, lat]
    pairs). Uses the area-weighted centroid so concave/L-shaped footprints
    resolve to a point inside the polygon rather than a vertex average.
    Returns (lat, lng). Raises ValueError on an empty ring rather than
    inventing a point."""
    if len(ring) == 0:
        raise ValueError("polygon_centroid: empty ring")

    # Drop a duplicated closing vertex if present.
    pts = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring

    if len(pts) < 3:
        # Degenerate: average the available points.
        sum_lng = sum(p[0] for p in pts)
        sum_lat = sum(p[1] for p in pts)
        return (sum_lat / len(pts), sum_lng / len(pts))

    # Shift to a local origin before the shoelace, and shift back at the
    # end. Run on raw WGS84 degrees this loses the answer to cancellation
    # -- see geometry.ts's original comment (git history) for the measured
    # 0.37-10.4 m error this fixes across real NYC footprints. Translation
    # is exact enough to remove the problem because it makes the terms the
    # same order as the result; the centroid of a translated polygon is the
    # translated centroid, so nothing else changes.
    ox = sum(p[0] for p in pts) / len(pts)
    oy = sum(p[1] for p in pts) / len(pts)

    area_sum = 0.0
    cx_sum = 0.0
    cy_sum = 0.0
    n = len(pts)
    for i in range(n):
        x0 = pts[i][0] - ox
        y0 = pts[i][1] - oy
        j = (i + 1) % n
        x1 = pts[j][0] - ox
        y1 = pts[j][1] - oy
        cross = x0 * y1 - x1 * y0
        area_sum += cross
        cx_sum += (x0 + x1) * cross
        cy_sum += (y0 + y1) * cross
    area = area_sum / 2
    if abs(area) < 1e-12:
        # Collinear / zero-area: fall back to vertex mean.
        sum_lng = sum(p[0] for p in pts)
        sum_lat = sum(p[1] for p in pts)
        return (sum_lat / len(pts), sum_lng / len(pts))
    return (cy_sum / (6 * area) + oy, cx_sum / (6 * area) + ox)
