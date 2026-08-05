import { describe, it, expect } from "vitest";
import {
  normalizeStreet,
  normalizeHouseNumber,
  verifyAddressMatch,
} from "./addressMatch";

/**
 * Every fixture below is a VERBATIM capture of a live NYC Planning GeoSearch
 * response (https://geosearch.planninglabs.nyc/v2/search), taken 2026-08-04.
 * They are the actual evidence that Pelias fuzzy-substitutes a different
 * building for an unresolvable address while still reporting
 * `confidence: 0.8, match_type: "fallback"` — the same values it reports for a
 * perfect hit, which is why this module compares fields instead of trusting the
 * score.
 */
const REAL_MATCHES = [
  {
    query: "350 5th Ave, Manhattan, New York, NY 10118",
    parsed: { housenumber: "350", street: "5th Ave", locality: "Manhattan", region: "New York" },
    matched: {
      housenumber: "350",
      street: "5 AVENUE",
      locality: "New York",
      borough: "Manhattan",
      region_a: "NY",
      label: "350 5 AVENUE, New York, NY, USA",
    },
  },
  {
    query: "1 W 72nd St, Manhattan, New York, NY 10023",
    parsed: { housenumber: "1", street: "W 72nd St", locality: "Manhattan", region: "New York" },
    matched: {
      housenumber: "1",
      street: "WEST 72 STREET",
      locality: "New York",
      borough: "Manhattan",
      region_a: "NY",
      label: "1 WEST 72 STREET, New York, NY, USA",
    },
  },
  {
    query: "11 Wall St",
    parsed: { housenumber: "11", street: "Wall St" },
    matched: {
      housenumber: "11",
      street: "WALL STREET",
      locality: "New York",
      borough: "Manhattan",
      region_a: "NY",
      label: "11 WALL STREET, New York, NY, USA",
    },
  },
  {
    query: "30 Rockefeller Plaza, Manhattan, New York, NY 10112",
    parsed: { housenumber: "30", street: "Rockefeller Plaza", locality: "Manhattan", region: "New York" },
    matched: {
      housenumber: "30",
      street: "ROCKEFELLER PLAZA",
      locality: "New York",
      borough: "Manhattan",
      region_a: "NY",
      label: "30 ROCKEFELLER PLAZA, New York, NY, USA",
    },
  },
  {
    query: "89-14 Parsons Blvd, Jamaica, NY 11432",
    parsed: { housenumber: "89-14", street: "Parsons Blvd", locality: "Jamaica", region: "NY" },
    matched: {
      housenumber: "89-14",
      street: "PARSONS BOULEVARD",
      locality: "New York",
      borough: "Queens",
      region_a: "NY",
      label: "89-14 PARSONS BOULEVARD, Jamaica, NY, USA",
    },
  },
  {
    query: "1000 Grand Concourse, Bronx, NY",
    parsed: { housenumber: "1000", street: "Grand Concourse", locality: "Bronx", region: "NY" },
    matched: {
      housenumber: "1000",
      street: "GRAND CONCOURSE",
      locality: "New York",
      borough: "Bronx",
      region_a: "NY",
      label: "1000 GRAND CONCOURSE, Bronx, NY, USA",
    },
  },
];

const FUZZY_SUBSTITUTIONS = [
  {
    query: "1 Infinite Loop, Cupertino, CA",
    expect: "not-nyc",
    parsed: { housenumber: "1", street: "Infinite Loop", locality: "Cupertino", region: "CA" },
    matched: {
      housenumber: "1",
      street: "ASH LOOP",
      locality: "New York",
      borough: "Bronx",
      region_a: "NY",
      label: "1 ASH LOOP, Bronx, NY, USA",
    },
  },
  {
    query: "10 Downing Street, London",
    expect: "not-nyc",
    parsed: { housenumber: "10", street: "Downing Street", locality: "London" },
    matched: {
      housenumber: "10",
      street: "DOWNING STREET",
      locality: "New York",
      borough: "Manhattan",
      region_a: "NY",
      label: "10 DOWNING STREET, New York, NY, USA",
    },
  },
  {
    query: "123 Fake Street, Brooklyn, NY",
    expect: "geocode-failed",
    parsed: { housenumber: "123", street: "Fake Street", locality: "Brooklyn", region: "NY" },
    matched: {
      housenumber: "123",
      street: "SCHERMERHORN STREET",
      locality: "New York",
      borough: "Brooklyn",
      region_a: "NY",
      label: "123 SCHERMERHORN STREET, Brooklyn, NY, USA",
    },
  },
  {
    query: "77777 Imaginary Ave, Queens, NY",
    expect: "geocode-failed",
    parsed: { housenumber: "77777", street: "Imaginary Ave", locality: "Queens", region: "NY" },
    matched: {
      housenumber: "77777",
      street: "SPRINGFIELD AVENUE",
      locality: "New York",
      borough: "Queens",
      region_a: "NY",
      label: "77777 SPRINGFIELD AVENUE, Cambria Heights, NY, USA",
    },
  },
  {
    query: "1 Central Park, Manhattan, New York, NY",
    expect: "geocode-failed",
    parsed: { housenumber: "1", street: "Central Park", locality: "Manhattan", region: "New York" },
    matched: {
      housenumber: "1",
      street: "CENTRAL PARK SOUTH",
      locality: "New York",
      borough: "Manhattan",
      region_a: "NY",
      label: "1 CENTRAL PARK SOUTH, New York, NY, USA",
    },
  },
  {
    // Regression: verbatim live GeoSearch response, 2026-08-04. GeoSearch
    // transposes the hyphenated Queens house number (31-45 -> 45-31) and lands
    // in a different neighbourhood. Astoria IS in New York City, so the refusal
    // must be "we couldn't find that exact address", NOT "that address looks
    // like it's in Astoria / 27B only covers New York City" — which is what the
    // old locality-first check produced, and which is simply untrue.
    query: "31-45 45th St, Astoria, Queens, NY",
    expect: "geocode-failed",
    parsed: { housenumber: "31-45", street: "45th St", locality: "Astoria", region: "NY" },
    matched: {
      housenumber: "45-31",
      street: "45 STREET",
      locality: "New York",
      borough: "Queens",
      region_a: "NY",
      label: "45-31 45 STREET, Sunnyside, NY, USA",
    },
  },
];

describe("normalizeStreet", () => {
  it("expands abbreviations and strips ordinal suffixes", () => {
    expect(normalizeStreet("W 72nd St")).toEqual(["WEST", "72", "STREET"]);
    expect(normalizeStreet("5th Ave")).toEqual(["5", "AVENUE"]);
    expect(normalizeStreet("Parsons Blvd.")).toEqual(["PARSONS", "BOULEVARD"]);
  });

  it("maps both spellings of a street to the same tokens", () => {
    expect(normalizeStreet("W 72nd St")).toEqual(normalizeStreet("WEST 72 STREET"));
    expect(normalizeStreet("5th Ave")).toEqual(normalizeStreet("5 AVENUE"));
  });
});

describe("normalizeHouseNumber", () => {
  it("keeps hyphenated Queens numbers intact", () => {
    expect(normalizeHouseNumber("89-14")).toBe("89-14");
  });
  it("drops leading zeros and whitespace", () => {
    expect(normalizeHouseNumber(" 007 ")).toBe("7");
  });
});

describe("verifyAddressMatch — real GeoSearch responses", () => {
  it.each(REAL_MATCHES)("accepts $query", ({ parsed, matched }) => {
    expect(verifyAddressMatch(parsed, matched)).toEqual({ ok: true });
  });

  it.each(FUZZY_SUBSTITUTIONS)(
    "rejects $query as $expect",
    ({ parsed, matched, expect: kind }) => {
      const verdict = verifyAddressMatch(parsed, matched);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.kind).toBe(kind);
    },
  );

  it("refuses when the geocoder returned no street to check against", () => {
    const verdict = verifyAddressMatch(
      { housenumber: "1", street: "Wall St" },
      { housenumber: "1", label: "somewhere" },
    );
    expect(verdict.ok).toBe(false);
  });

  it("refuses when the house number was substituted", () => {
    const verdict = verifyAddressMatch(
      { housenumber: "350", street: "5th Ave" },
      { housenumber: "352", street: "5 AVENUE", label: "352 5 AVENUE" },
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.kind).toBe("geocode-failed");
  });
});
