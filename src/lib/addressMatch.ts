// Verify that the geocoder actually found the address the user typed.
//
// WHY THIS FILE EXISTS (this was a real, product-breaking bug):
//
// NYC Planning's GeoSearch is a Pelias instance. Pelias always returns its best
// candidate; for an address it cannot resolve it falls back to a fuzzy match and
// still reports `confidence: 0.8, match_type: "fallback"` — the SAME values it
// reports for a perfect hit. Measured against the live service on 2026-08-04:
//
//   "1 Infinite Loop, Cupertino, CA"  -> 1 ASH LOOP, Bronx, NY
//   "123 Fake Street, Brooklyn, NY"   -> 123 SCHERMERHORN STREET, Brooklyn, NY
//   "77777 Imaginary Ave, Queens, NY" -> 77777 SPRINGFIELD AVENUE, Queens, NY
//   "10 Downing Street, London"       -> 10 DOWNING STREET, New York, NY
//
// The app then rendered *real* imagery of a *different building* and captioned
// it with the user's address. The imagery constraint was satisfied and the
// product was still lying. Neither `confidence` nor `match_type` can separate
// these cases, so this module compares the geocoder's own parse of the query
// (`geocoding.query.parsed_text`) against the properties of the feature it
// returned, and refuses anything that doesn't line up.
//
// Refusal is routed to the same honest "not available" state as every other
// failure — never to a substituted location.

/** Pelias's parse of what the user typed (response.geocoding.query.parsed_text). */
export interface ParsedQuery {
  housenumber?: string;
  street?: string;
  locality?: string;
  region?: string;
  postalcode?: string;
}

/** The subset of the returned feature's properties we verify against. */
export interface MatchedAddress {
  housenumber?: string;
  street?: string;
  locality?: string;
  borough?: string;
  region_a?: string;
  label?: string;
}

export type MatchVerdict =
  | { ok: true }
  | { ok: false; kind: "not-nyc" | "geocode-failed"; message: string };

/** Street-type and directional abbreviations seen in NYC address input. */
const ABBREVIATIONS: Record<string, string> = {
  ST: "STREET",
  STR: "STREET",
  AVE: "AVENUE",
  AV: "AVENUE",
  BLVD: "BOULEVARD",
  BLV: "BOULEVARD",
  RD: "ROAD",
  DR: "DRIVE",
  PL: "PLACE",
  PLZ: "PLAZA",
  PKWY: "PARKWAY",
  PKY: "PARKWAY",
  LN: "LANE",
  CT: "COURT",
  TER: "TERRACE",
  TERR: "TERRACE",
  SQ: "SQUARE",
  HWY: "HIGHWAY",
  EXPY: "EXPRESSWAY",
  CIR: "CIRCLE",
  N: "NORTH",
  S: "SOUTH",
  E: "EAST",
  W: "WEST",
  NE: "NORTHEAST",
  NW: "NORTHWEST",
  SE: "SOUTHEAST",
  SW: "SOUTHWEST",
};

/** Localities that are unambiguously within the five boroughs. */
const NYC_LOCALITIES = new Set([
  "NEW YORK",
  "NEW YORK CITY",
  "NYC",
  "MANHATTAN",
  "BROOKLYN",
  "QUEENS",
  "BRONX",
  "THE BRONX",
  "STATEN ISLAND",
]);

/**
 * Canonical tokens for a street name: uppercase, punctuation stripped,
 * abbreviations expanded, ordinal suffixes removed ("5TH" -> "5", "72ND" -> 72).
 * "W 72nd St" and "WEST 72 STREET" both normalize to ["WEST", "72", "STREET"].
 */
export function normalizeStreet(street: string): string[] {
  return street
    .toUpperCase()
    .replace(/[.,#]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/^(\d+)(ST|ND|RD|TH)$/, "$1"))
    .map((t) => ABBREVIATIONS[t] ?? t);
}

/** Normalize a house number for comparison ("89-14" and "89-14" only). */
export function normalizeHouseNumber(hn: string): string {
  return hn.toUpperCase().replace(/\s+/g, "").replace(/^0+(?=\d)/, "");
}

/**
 * Decide whether a GeoSearch result really is the address that was typed.
 *
 * Three checks, in order of how badly they mislead a user:
 *   1. region (state) — a non-NY state in the query means the user meant
 *      somewhere else entirely.
 *   2. locality (city) — must be a NYC locality, or must actually appear in the
 *      matched label (so "Jamaica", "Astoria", "Riverdale" etc. still pass).
 *   3. house number + street — must match after normalization. This is the check
 *      that catches the fuzzy street fallback.
 */
export function verifyAddressMatch(
  parsed: ParsedQuery,
  matched: MatchedAddress,
): MatchVerdict {
  const notNyc = (what: string): MatchVerdict => ({
    ok: false,
    kind: "not-nyc",
    message: `That address looks like it's in ${what}. 27B only covers New York City.`,
  });
  const notFound: MatchVerdict = {
    ok: false,
    kind: "geocode-failed",
    message:
      "We couldn't find that exact address in New York City. Check the street name and try again.",
  };

  const region = parsed.region?.trim().toUpperCase();
  if (region && region !== "NY" && region !== "NEW YORK") {
    return notNyc(parsed.region!.trim());
  }

  const locality = parsed.locality?.trim().toUpperCase();
  if (locality && !NYC_LOCALITIES.has(locality)) {
    const label = (matched.label ?? "").toUpperCase();
    const inLabel = label.includes(locality);
    const isBorough = (matched.borough ?? "").toUpperCase() === locality;
    const isMatchedLocality =
      (matched.locality ?? "").toUpperCase() === locality;
    if (!inLabel && !isBorough && !isMatchedLocality) {
      return notNyc(parsed.locality!.trim());
    }
  }

  // Without a parsed street there is nothing to verify against, and an
  // unverified match is exactly the failure mode this module exists to stop.
  if (!parsed.street || !matched.street) return notFound;

  if (parsed.housenumber && matched.housenumber) {
    if (
      normalizeHouseNumber(parsed.housenumber) !==
      normalizeHouseNumber(matched.housenumber)
    ) {
      return notFound;
    }
  }

  const want = normalizeStreet(parsed.street);
  const got = normalizeStreet(matched.street);
  if (want.length !== got.length || want.some((t, i) => t !== got[i])) {
    return notFound;
  }

  return { ok: true };
}
