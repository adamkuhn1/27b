"""Address matching, footprint parsing, and plan orchestration tests."""

import pytest

import geometry
import models
import planning
from planning import FootprintError, GeocodeError

# ---------------------------------------------------------------------------
# Address matching
# ---------------------------------------------------------------------------

# Every fixture below is a VERBATIM capture of a live NYC Planning GeoSearch
# response (https://geosearch.planninglabs.nyc/v2/search), taken 2026-08-04.
# They are the actual evidence that Pelias fuzzy-substitutes a different
# building for an unresolvable address while still reporting confidence:
# 0.8, match_type: "fallback" -- the same values it reports for a perfect
# hit, which is why this module compares fields instead of trusting the
# score.
REAL_MATCHES = [
    (
        "350 5th Ave, Manhattan, New York, NY 10118",
        {"housenumber": "350", "street": "5th Ave", "locality": "Manhattan", "region": "New York"},
        {"housenumber": "350", "street": "5 AVENUE", "locality": "New York", "borough": "Manhattan", "region_a": "NY", "label": "350 5 AVENUE, New York, NY, USA"},
    ),
    (
        "1 W 72nd St, Manhattan, New York, NY 10023",
        {"housenumber": "1", "street": "W 72nd St", "locality": "Manhattan", "region": "New York"},
        {"housenumber": "1", "street": "WEST 72 STREET", "locality": "New York", "borough": "Manhattan", "region_a": "NY", "label": "1 WEST 72 STREET, New York, NY, USA"},
    ),
    (
        "11 Wall St",
        {"housenumber": "11", "street": "Wall St"},
        {"housenumber": "11", "street": "WALL STREET", "locality": "New York", "borough": "Manhattan", "region_a": "NY", "label": "11 WALL STREET, New York, NY, USA"},
    ),
    (
        "30 Rockefeller Plaza, Manhattan, New York, NY 10112",
        {"housenumber": "30", "street": "Rockefeller Plaza", "locality": "Manhattan", "region": "New York"},
        {"housenumber": "30", "street": "ROCKEFELLER PLAZA", "locality": "New York", "borough": "Manhattan", "region_a": "NY", "label": "30 ROCKEFELLER PLAZA, New York, NY, USA"},
    ),
    (
        "89-14 Parsons Blvd, Jamaica, NY 11432",
        {"housenumber": "89-14", "street": "Parsons Blvd", "locality": "Jamaica", "region": "NY"},
        {"housenumber": "89-14", "street": "PARSONS BOULEVARD", "locality": "New York", "borough": "Queens", "region_a": "NY", "label": "89-14 PARSONS BOULEVARD, Jamaica, NY, USA"},
    ),
    (
        "1000 Grand Concourse, Bronx, NY",
        {"housenumber": "1000", "street": "Grand Concourse", "locality": "Bronx", "region": "NY"},
        {"housenumber": "1000", "street": "GRAND CONCOURSE", "locality": "New York", "borough": "Bronx", "region_a": "NY", "label": "1000 GRAND CONCOURSE, Bronx, NY, USA"},
    ),
]

FUZZY_SUBSTITUTIONS = [
    (
        "1 Infinite Loop, Cupertino, CA", "not-nyc",
        {"housenumber": "1", "street": "Infinite Loop", "locality": "Cupertino", "region": "CA"},
        {"housenumber": "1", "street": "ASH LOOP", "locality": "New York", "borough": "Bronx", "region_a": "NY", "label": "1 ASH LOOP, Bronx, NY, USA"},
    ),
    (
        "10 Downing Street, London", "not-nyc",
        {"housenumber": "10", "street": "Downing Street", "locality": "London"},
        {"housenumber": "10", "street": "DOWNING STREET", "locality": "New York", "borough": "Manhattan", "region_a": "NY", "label": "10 DOWNING STREET, New York, NY, USA"},
    ),
    (
        "123 Fake Street, Brooklyn, NY", "geocode-failed",
        {"housenumber": "123", "street": "Fake Street", "locality": "Brooklyn", "region": "NY"},
        {"housenumber": "123", "street": "SCHERMERHORN STREET", "locality": "New York", "borough": "Brooklyn", "region_a": "NY", "label": "123 SCHERMERHORN STREET, Brooklyn, NY, USA"},
    ),
    (
        "77777 Imaginary Ave, Queens, NY", "geocode-failed",
        {"housenumber": "77777", "street": "Imaginary Ave", "locality": "Queens", "region": "NY"},
        {"housenumber": "77777", "street": "SPRINGFIELD AVENUE", "locality": "New York", "borough": "Queens", "region_a": "NY", "label": "77777 SPRINGFIELD AVENUE, Cambria Heights, NY, USA"},
    ),
    (
        "1 Central Park, Manhattan, New York, NY", "geocode-failed",
        {"housenumber": "1", "street": "Central Park", "locality": "Manhattan", "region": "New York"},
        {"housenumber": "1", "street": "CENTRAL PARK SOUTH", "locality": "New York", "borough": "Manhattan", "region_a": "NY", "label": "1 CENTRAL PARK SOUTH, New York, NY, USA"},
    ),
    (
        # Regression: verbatim live GeoSearch response, 2026-08-04. GeoSearch
        # transposes the hyphenated Queens house number (31-45 -> 45-31) and
        # lands in a different neighbourhood. Astoria IS in New York City,
        # so the refusal must be "we couldn't find that exact address", NOT
        # "that address looks like it's in Astoria" -- which is what the old
        # locality-first check produced, and which is simply untrue.
        "31-45 45th St, Astoria, Queens, NY", "geocode-failed",
        {"housenumber": "31-45", "street": "45th St", "locality": "Astoria", "region": "NY"},
        {"housenumber": "45-31", "street": "45 STREET", "locality": "New York", "borough": "Queens", "region_a": "NY", "label": "45-31 45 STREET, Sunnyside, NY, USA"},
    ),
]


class TestNormalizeStreet:
    def test_expands_abbreviations_and_strips_ordinal_suffixes(self):
        assert planning.normalize_street("W 72nd St") == ["WEST", "72", "STREET"]
        assert planning.normalize_street("5th Ave") == ["5", "AVENUE"]
        assert planning.normalize_street("Parsons Blvd.") == ["PARSONS", "BOULEVARD"]

    def test_maps_both_spellings_to_same_tokens(self):
        assert planning.normalize_street("W 72nd St") == planning.normalize_street("WEST 72 STREET")
        assert planning.normalize_street("5th Ave") == planning.normalize_street("5 AVENUE")


class TestNormalizeHouseNumber:
    def test_keeps_hyphenated_queens_numbers_intact(self):
        assert planning.normalize_house_number("89-14") == "89-14"

    def test_drops_leading_zeros_and_whitespace(self):
        assert planning.normalize_house_number(" 007 ") == "7"


class TestVerifyAddressMatchRealResponses:
    @pytest.mark.parametrize("query,parsed,matched", REAL_MATCHES)
    def test_accepts(self, query, parsed, matched):
        assert planning.verify_address_match(parsed, matched) == {"ok": True}

    @pytest.mark.parametrize("query,expected_kind,parsed,matched", FUZZY_SUBSTITUTIONS)
    def test_rejects(self, query, expected_kind, parsed, matched):
        verdict = planning.verify_address_match(parsed, matched)
        assert verdict["ok"] is False
        assert verdict["kind"] == expected_kind

    def test_refuses_when_no_street_to_check_against(self):
        verdict = planning.verify_address_match(
            {"housenumber": "1", "street": "Wall St"},
            {"housenumber": "1", "label": "somewhere"},
        )
        assert verdict["ok"] is False

    def test_refuses_when_house_number_was_substituted(self):
        verdict = planning.verify_address_match(
            {"housenumber": "350", "street": "5th Ave"},
            {"housenumber": "352", "street": "5 AVENUE", "label": "352 5 AVENUE"},
        )
        assert verdict["ok"] is False
        assert verdict["kind"] == "geocode-failed"


# ---------------------------------------------------------------------------
# Footprint parsing
# ---------------------------------------------------------------------------

FT_TO_M = 0.3048

POLYGON_GEOM = {
    "type": "Polygon",
    "coordinates": [[
        [-74.006, 40.7128], [-74.006, 40.7130], [-74.004, 40.7130], [-74.004, 40.7128], [-74.006, 40.7128],
    ]],
}


class TestParseFootprint:
    def test_converts_feet_to_meters(self):
        fp = planning.parse_footprint(
            {"bin": "1012345", "height_roof": "300", "ground_elevation": "40", "the_geom": POLYGON_GEOM}, "1012345"
        )
        assert fp.roof_height_m == pytest.approx(300 * FT_TO_M, abs=1e-6)
        assert fp.ground_elevation_navd88_m == pytest.approx(40 * FT_TO_M, abs=1e-6)
        assert fp.bin == "1012345"

    def test_computes_centroid_inside_footprint(self):
        fp = planning.parse_footprint(
            {"bin": "1012345", "height_roof": "300", "ground_elevation": "40", "the_geom": POLYGON_GEOM}, "1012345"
        )
        lat, lng = fp.centroid
        assert -74.006 < lng < -74.004
        assert 40.7128 < lat < 40.713

    def test_handles_multipolygon_by_using_first_ring(self):
        multi = {"type": "MultiPolygon", "coordinates": [POLYGON_GEOM["coordinates"]]}
        fp = planning.parse_footprint({"bin": "2", "height_roof": "120", "ground_elevation": "5", "the_geom": multi}, "2")
        assert fp.roof_height_m == pytest.approx(120 * FT_TO_M, abs=1e-6)
        assert fp.centroid[1] < -74.004

    def test_defaults_ground_elevation_to_zero_when_missing(self):
        fp = planning.parse_footprint({"bin": "3", "height_roof": "80", "the_geom": POLYGON_GEOM}, "3")
        assert fp.ground_elevation_navd88_m == 0

    def test_refuses_when_roof_height_missing(self):
        with pytest.raises(FootprintError):
            planning.parse_footprint({"bin": "4", "ground_elevation": "10", "the_geom": POLYGON_GEOM}, "4")

    def test_refuses_when_roof_height_zero_or_negative(self):
        with pytest.raises(FootprintError):
            planning.parse_footprint({"bin": "5", "height_roof": "0", "ground_elevation": "10", "the_geom": POLYGON_GEOM}, "5")

    def test_refuses_when_geometry_missing(self):
        with pytest.raises(FootprintError):
            planning.parse_footprint({"bin": "6", "height_roof": "90", "ground_elevation": "10"}, "6")

    def test_tags_refusals_with_no_footprint_kind(self):
        with pytest.raises(FootprintError) as exc_info:
            planning.parse_footprint({"bin": "7", "ground_elevation": "10", "the_geom": POLYGON_GEOM}, "7")
        assert exc_info.value.kind == "no-footprint"


# ---------------------------------------------------------------------------
# Plan orchestration (plan_view)
# ---------------------------------------------------------------------------

ESB = next(b for b in planning.CURATED_BUILDINGS if b.name == "Empire State Building")


def _geocode_ok(bin: str | None):
    async def fake(address: str) -> models.GeocodeResult:
        return models.GeocodeResult(
            label="350 5 AVENUE, New York, NY, USA", lat=40.748441, lng=-73.985656, bin=bin, borough="Manhattan"
        )

    return fake


FOOTPRINT = geometry.Footprint(
    bin=ESB.bin,
    roof_height_m=380,
    ground_elevation_navd88_m=15,
    centroid=(40.748441, -73.985656),
    ring=[(-73.9861, 40.748), (-73.9851, 40.748), (-73.9851, 40.7489), (-73.9861, 40.7489), (-73.9861, 40.748)],
)


async def _fetch_footprint_ok(bin: str) -> geometry.Footprint:
    return FOOTPRINT


class TestPlanView:
    @pytest.mark.asyncio
    async def test_produces_plan_for_curated_building_at_verified_floor(self):
        result = await planning.plan_view(
            "350 5th Ave", 80, geocode=_geocode_ok(ESB.bin), fetch_footprint=_fetch_footprint_ok
        )
        assert result.ok is True
        assert result.plan.curated_name == ESB.name
        assert len(result.plan.views) == 4
        # The ellipsoidal height must carry the ~-32 m NYC geoid correction.
        assert result.plan.eye_elevation_navd88_m - result.plan.eye_elevation_ellipsoidal_m > 25

    @pytest.mark.asyncio
    async def test_refuses_uncurated_building_before_fetching_footprint(self):
        calls = []

        async def fetch_footprint(bin: str) -> geometry.Footprint:
            calls.append(bin)
            return FOOTPRINT

        result = await planning.plan_view(
            "999 Nowhere St", 5, geocode=_geocode_ok("1000001"), fetch_footprint=fetch_footprint
        )
        assert result.ok is False
        assert result.reason == "not-supported"
        assert calls == []

    @pytest.mark.asyncio
    async def test_refuses_curated_building_outside_verified_floor_range(self):
        result = await planning.plan_view(
            "350 5th Ave", 2, geocode=_geocode_ok(ESB.bin), fetch_footprint=_fetch_footprint_ok
        )
        assert result.ok is False
        assert result.reason == "not-supported"
        assert result.supported_floors == ESB.floors

    @pytest.mark.asyncio
    async def test_maps_missing_bin_to_no_footprint(self):
        result = await planning.plan_view(
            "1 Somewhere", 3, geocode=_geocode_ok(None), fetch_footprint=_fetch_footprint_ok
        )
        assert result.ok is False
        assert result.reason == "no-footprint"

    @pytest.mark.asyncio
    async def test_routes_geocode_errors_to_their_own_reasons(self):
        for kind in ("not-nyc", "geocode-failed", "network-error"):
            async def failing_geocode(address: str, _kind=kind) -> models.GeocodeResult:
                raise GeocodeError("nope", _kind)

            result = await planning.plan_view(
                "x", 3, geocode=failing_geocode, fetch_footprint=_fetch_footprint_ok
            )
            assert result.ok is False
            assert result.reason == kind
            assert result.message == "nope"

    @pytest.mark.asyncio
    async def test_routes_footprint_errors_to_their_own_reasons(self):
        async def failing_fetch(bin: str) -> geometry.Footprint:
            raise FootprintError("no record", "no-footprint")

        result = await planning.plan_view(
            "350 5th Ave", 80, geocode=_geocode_ok(ESB.bin), fetch_footprint=failing_fetch
        )
        assert result.ok is False
        assert result.reason == "no-footprint"


class TestCuratedListIntegrity:
    def test_unique_bins_and_sane_floor_ranges(self):
        bins = [b.bin for b in planning.CURATED_BUILDINGS]
        assert len(set(bins)) == len(bins)
        for b in planning.CURATED_BUILDINGS:
            assert b.floors.min >= 1
            assert b.floors.max >= b.floors.min
            assert b.floors.min <= b.suggested_floor <= b.floors.max
            assert len(b.verified_at) == 10 and b.verified_at[4] == "-" and b.verified_at[7] == "-"
            assert len(b.bin) == 7 and b.bin.isdigit()
