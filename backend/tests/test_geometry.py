"""Camera geometry and geoid-interpolation tests."""

import math

import pytest

import geometry
from geometry import Footprint

# A simple 100 m x 80 m rectangle centred at the building centroid (~ +-50 m
# N/S, +-40 m E/W in degrees). Axis-aligned to true north on purpose so the
# facade basis and the compass basis coincide for the elevation/offset tests.
CENTROID = (40.7128, -74.006)  # (lat, lng)
RING: geometry.Ring = [
    (CENTROID[1] - 0.00036, CENTROID[0] - 0.00045),  # SW
    (CENTROID[1] + 0.00036, CENTROID[0] - 0.00045),  # SE
    (CENTROID[1] + 0.00036, CENTROID[0] + 0.00045),  # NE
    (CENTROID[1] - 0.00036, CENTROID[0] + 0.00045),  # NW
    (CENTROID[1] - 0.00036, CENTROID[0] - 0.00045),  # close
]

BUILDING = Footprint(
    bin="1000000",
    roof_height_m=100,  # ~31 floors of headroom
    ground_elevation_navd88_m=10,
    centroid=CENTROID,
    ring=RING,
)

# The Empire State Building's real NYC OpenData footprint ring (BIN 1015862,
# dataset 5zhs-2jue, fetched 2026-08-04). Used to prove the facade math on a
# building that is emphatically NOT aligned to true north.
ESB_RING: geometry.Ring = [
    (-73.98608527878, 40.748921498021),
    (-73.98482339139, 40.74839078918),
    (-73.984909832216, 40.748271913883),
    (-73.985031089296, 40.74810515772),
    (-73.985157291953, 40.747931600537),
    (-73.98648794223, 40.748491226399),
    (-73.986469871701, 40.748516078254),
    (-73.986682947706, 40.748605687253),
    (-73.98655560005, 40.748780826345),
    (-73.98635802669, 40.748697735913),
    (-73.986345130771, 40.748715469858),
    (-73.98632962892, 40.748708950154),
    (-73.986312563843, 40.748732419825),
    (-73.986154048034, 40.748950418863),
    (-73.98608527878, 40.748921498021),
]
ESB_CENTROID = geometry.polygon_centroid(ESB_RING)
ESB = Footprint(
    bin="1015862",
    roof_height_m=1238.79032716 * 0.3048,
    ground_elevation_navd88_m=50 * 0.3048,
    centroid=ESB_CENTROID,
    ring=ESB_RING,
)


class TestEstimateFloorElevation:
    def test_floor_1_at_ground_plus_eye_height(self):
        e = geometry.estimate_floor_elevation(BUILDING, 1)
        assert e.eye_elevation_navd88_m == pytest.approx(10 + geometry.EYE_ABOVE_FLOOR_M, abs=1e-6)
        assert e.clamped_to_roof is False

    def test_adds_one_floor_height_per_floor_above_first(self):
        f5 = geometry.estimate_floor_elevation(BUILDING, 5)
        expected_above_ground = 4 * geometry.ASSUMED_FLOOR_HEIGHT_M + geometry.EYE_ABOVE_FLOOR_M
        assert f5.eye_elevation_navd88_m == pytest.approx(10 + expected_above_ground, abs=1e-6)

    def test_clamps_to_real_roof(self):
        tall = geometry.estimate_floor_elevation(BUILDING, 200)
        assert tall.clamped_to_roof is True
        assert tall.eye_elevation_navd88_m == pytest.approx(10 + 100, abs=1e-6)

    def test_does_not_clamp_when_floor_fits_under_roof(self):
        f10 = geometry.estimate_floor_elevation(BUILDING, 10)
        assert f10.clamped_to_roof is False
        assert f10.eye_elevation_navd88_m < BUILDING.ground_elevation_navd88_m + BUILDING.roof_height_m

    def test_converts_navd88_to_ellipsoidal_the_32m_datum_fix(self):
        e = geometry.estimate_floor_elevation(BUILDING, 27)
        undulation = geometry.geoid_height_m(*CENTROID)
        assert undulation < -30  # NYC geoid is ~ -31.7 m
        assert e.geoid_height_m == pytest.approx(undulation, abs=1e-9)
        assert e.eye_elevation_ellipsoidal_m == pytest.approx(e.eye_elevation_navd88_m + undulation, abs=1e-9)
        # The correction is worth about ten floors: it must not be a no-op.
        assert e.eye_elevation_navd88_m - e.eye_elevation_ellipsoidal_m > 25

    def test_keeps_floors_materially_separated_after_datum_conversion(self):
        low = geometry.estimate_floor_elevation(BUILDING, 4)
        high = geometry.estimate_floor_elevation(BUILDING, 28)
        delta = high.eye_elevation_ellipsoidal_m - low.eye_elevation_ellipsoidal_m
        assert delta == pytest.approx(24 * geometry.ASSUMED_FLOOR_HEIGHT_M, abs=1e-6)


class TestOffsetLatLng:
    def test_north_increases_latitude(self):
        lat, lng = geometry.offset_lat_lng(40.7128, -74.006, 0, 100)
        assert lat > 40.7128
        assert lng == pytest.approx(-74.006, abs=1e-6)

    def test_east_increases_longitude(self):
        lat, lng = geometry.offset_lat_lng(40.7128, -74.006, 90, 100)
        assert lng > -74.006
        assert lat == pytest.approx(40.7128, abs=1e-6)

    def test_south_decreases_latitude(self):
        lat, _ = geometry.offset_lat_lng(40.7128, -74.006, 180, 100)
        assert lat < 40.7128

    def test_west_decreases_longitude(self):
        _, lng = geometry.offset_lat_lng(40.7128, -74.006, 270, 100)
        assert lng < -74.006

    def test_100m_north_is_about_0_0009_degrees(self):
        lat, _ = geometry.offset_lat_lng(40.7128, -74.006, 0, 100)
        assert (lat - 40.7128) == pytest.approx(100 / 111_320, abs=1e-5)


class TestFacadeDistanceM:
    def test_positive_distance_for_north_facing_ray(self):
        d = geometry.facade_distance_m(RING, CENTROID, 0)
        assert d > 0
        assert d == pytest.approx(0.00045 * 111_320, abs=0.5)

    def test_symmetric_for_opposite_bearings(self):
        north = geometry.facade_distance_m(RING, CENTROID, 0)
        south = geometry.facade_distance_m(RING, CENTROID, 180)
        assert north == pytest.approx(south, abs=0.05)

    def test_zero_for_degenerate_ring(self):
        assert geometry.facade_distance_m([(0, 0), (1, 1)], CENTROID, 0) == 0

    def test_takes_outermost_crossing_on_courtyard_footprint(self):
        # C opening east; the area-weighted centroid falls in the notch,
        # which is a real situation for U- and C-shaped NYC buildings.
        # Going north from there, the ray ENTERS the top arm at ~30 m and
        # leaves it at ~50 m. Using the nearest crossing (the old, wrong
        # behaviour) would put the camera 6 m past 30 m -- i.e. inside the
        # building. The outermost crossing is the correct one.
        c = (0.0, 0.0)
        m = 1 / 111_320  # ~1 m in degrees latitude
        ring: geometry.Ring = [
            (-50 * m, -50 * m), (50 * m, -50 * m), (50 * m, -30 * m),
            (-20 * m, -30 * m), (-20 * m, 30 * m), (50 * m, 30 * m),
            (50 * m, 50 * m), (-50 * m, 50 * m), (-50 * m, -50 * m),
        ]
        d = geometry.facade_distance_m(ring, c, 0)
        assert 45 < d < 55

        local = geometry.ring_to_local_meters(ring, c)
        assert geometry.point_in_ring_meters(local, 0, d + 6) is False
        # Sanity: the nearest crossing would have been inside.
        assert geometry.point_in_ring_meters(local, 0, 30 + 6) is True


class TestPrincipalFacadeAxis:
    def test_north_aligned_rectangle_reads_near_zero_with_high_concentration(self):
        axis = geometry.principal_facade_axis(RING, CENTROID)
        assert axis.concentration > 0.95
        assert min(axis.bearing_deg, 90 - axis.bearing_deg) < 1

    def test_finds_manhattan_grid_rotation_on_real_esb_footprint(self):
        axis = geometry.principal_facade_axis(ESB_RING, ESB.centroid)
        assert axis.concentration > 0.8
        nearest = min(
            abs(axis.bearing_deg - 29),
            abs(axis.bearing_deg - 29 + 90),
            abs(axis.bearing_deg - 29 - 90),
        )
        assert nearest < 6

    def test_low_concentration_for_near_circular_footprint(self):
        ring: geometry.Ring = [
            (CENTROID[1] + 0.0003 * math.cos(2 * math.pi * i / 32), CENTROID[0] + 0.0003 * math.sin(2 * math.pi * i / 32))
            for i in range(32)
        ]
        assert geometry.principal_facade_axis(ring, CENTROID).concentration < 0.3


class TestViewBearings:
    def test_facade_basis_for_rectilinear_footprint(self):
        result = geometry.view_bearings(BUILDING)
        assert result.basis == "facade"
        assert len(result.bearings_deg) == 4
        for i in range(1, 4):
            assert result.bearings_deg[i] - result.bearings_deg[0] == pytest.approx(90 * i, abs=1e-6)

    def test_falls_back_to_compass_with_no_dominant_facade(self):
        ring: geometry.Ring = [
            (CENTROID[1] + 0.0003 * math.cos(2 * math.pi * i / 32), CENTROID[0] + 0.0003 * math.sin(2 * math.pi * i / 32))
            for i in range(32)
        ]
        circular = Footprint(**{**BUILDING.__dict__, "ring": ring})
        result = geometry.view_bearings(circular)
        assert result.basis == "compass"
        assert result.bearings_deg == [0, 90, 180, 270]


class TestBuildCameraViews:
    def test_four_slots_90_degrees_apart_with_downward_pitch(self):
        result = geometry.build_camera_views(BUILDING, 50, 40)
        assert [v.slot for v in result.views] == ["V1", "V2", "V3", "V4"]
        for v in result.views:
            assert v.height_m == 50
            assert v.pitch_deg < 0
            assert v.pitch_deg >= -9
            assert v.compass and all(c in "NESW" for c in v.compass)

    def test_every_camera_outside_footprint_polygon(self):
        for fp in (BUILDING, ESB):
            result = geometry.build_camera_views(fp, 50, 40)
            local = geometry.ring_to_local_meters(fp.ring, fp.centroid)
            for v in result.views:
                p = geometry.ring_to_local_meters([(v.lng, v.lat)], fp.centroid)[0]
                assert geometry.point_in_ring_meters(local, p[0], p[1]) is False
                assert v.standoff_m >= geometry.FACADE_OFFSET_M

    def test_aims_real_esb_views_along_facades_not_true_north(self):
        result = geometry.build_camera_views(ESB, 300, 250)
        assert result.basis == "facade"
        for v in result.views:
            off_grid = min(abs(v.heading_deg - c) for c in (0, 90, 180, 270, 360))
            assert off_grid > 5

    def test_moving_floor_up_moves_only_height(self):
        low = geometry.build_camera_views(BUILDING, 20, 10).views
        high = geometry.build_camera_views(BUILDING, 120, 110).views
        for i in range(4):
            assert high[i].height_m - low[i].height_m == pytest.approx(100, abs=1e-6)
            assert high[i].lat == pytest.approx(low[i].lat, abs=1e-9)
            assert high[i].lng == pytest.approx(low[i].lng, abs=1e-9)
            assert high[i].heading_deg == pytest.approx(low[i].heading_deg, abs=1e-9)

    def test_reports_footprint_rectangularity(self):
        assert geometry.build_camera_views(BUILDING, 50, 40).concentration > 0.9
        assert geometry.build_camera_views(ESB, 300, 250).concentration > 0.8

    def test_never_needs_placement_guard_on_concave_footprint(self):
        # The guard loop that pushes the camera further out if it lands back
        # inside the polygon is a safety net for pathological rings; for any
        # simple ring -- including a C whose centroid sits in the notch --
        # the outermost-crossing raycast has already left the polygon for
        # good, so the guard provably never fires.
        m = 1 / 111_320
        c = (0.0, 0.0)
        ring: geometry.Ring = [
            (-50 * m, -50 * m), (50 * m, -50 * m), (50 * m, -30 * m),
            (-20 * m, -30 * m), (-20 * m, 30 * m), (50 * m, 30 * m),
            (50 * m, 50 * m), (-50 * m, 50 * m), (-50 * m, -50 * m),
        ]
        concave = Footprint(bin="9", roof_height_m=40, ground_elevation_navd88_m=0, centroid=c, ring=ring)
        result = geometry.build_camera_views(concave, 30, 20)
        local = geometry.ring_to_local_meters(ring, c)
        for v in result.views:
            p = geometry.ring_to_local_meters([(v.lng, v.lat)], c)[0]
            assert geometry.point_in_ring_meters(local, p[0], p[1]) is False
            # Exactly the raycast distance plus the fixed offset: no extra push.
            wall = geometry.facade_distance_m(ring, c, v.heading_deg)
            assert v.standoff_m == pytest.approx(wall + geometry.FACADE_OFFSET_M, abs=1e-6)


class TestPolygonCentroid:
    def test_center_of_unit_square_closed_ring(self):
        ring: geometry.Ring = [(0, 0), (0, 2), (2, 2), (2, 0), (0, 0)]
        lat, lng = geometry.polygon_centroid(ring)
        assert lng == pytest.approx(1, abs=1e-6)
        assert lat == pytest.approx(1, abs=1e-6)

    def test_center_of_open_unclosed_ring(self):
        ring: geometry.Ring = [(0, 0), (0, 4), (4, 4), (4, 0)]
        lat, lng = geometry.polygon_centroid(ring)
        assert lng == pytest.approx(2, abs=1e-6)
        assert lat == pytest.approx(2, abs=1e-6)

    def test_l_shape_centroid_stays_inside_polygon(self):
        ring: geometry.Ring = [(0, 0), (0, 3), (1, 3), (1, 1), (3, 1), (3, 0)]
        lat, lng = geometry.polygon_centroid(ring)
        assert 0 < lng < 3
        assert 0 < lat < 3

    def test_throws_on_empty_ring_rather_than_inventing_a_point(self):
        with pytest.raises(ValueError):
            geometry.polygon_centroid([])


# ---------------------------------------------------------------------------
# Geoid interpolation (geoid_height_m)
# ---------------------------------------------------------------------------

# Ground truth sampled from NOAA NGS's Geoid Height Service (GEOID18) on
# 2026-08-04. These are independent of the lattice baked into geometry.py
# (none of them is a lattice node), so they measure real interpolation
# error, not self-consistency.
NOAA_SAMPLES = [
    ("Empire State Building", 40.7484, -73.9857, -31.752),
    ("One World Trade Center", 40.7127, -74.0134, -31.872),
    ("432 Park Avenue", 40.7616, -73.9718, -31.698),
    ("Bed-Stuy, Brooklyn", 40.6782, -73.9442, -31.813),
    ("Jamaica, Queens", 40.7282, -73.7949, -31.551),
    ("The Bronx", 40.8448, -73.8648, -31.336),
    ("Staten Island", 40.5795, -74.1502, -32.264),
    ("Upper East Side", 40.7794, -73.9632, -31.653),
]


class TestGeoidHeightM:
    @pytest.mark.parametrize("name,lat,lng,truth", NOAA_SAMPLES)
    def test_matches_noaa_within_5cm(self, name, lat, lng, truth):
        assert abs(geometry.geoid_height_m(lat, lng) - truth) < 0.05

    def test_negative_everywhere_in_nyc(self):
        for _, lat, lng, _ in NOAA_SAMPLES:
            assert geometry.geoid_height_m(lat, lng) < -30
            assert geometry.geoid_height_m(lat, lng) > -34

    def test_clamps_rather_than_extrapolating_outside_lattice(self):
        inside = geometry.geoid_height_m(40.4, -74.3)
        outside = geometry.geoid_height_m(39.0, -76.0)
        assert outside == pytest.approx(inside, abs=1e-9)
