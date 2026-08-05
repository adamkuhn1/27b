// Input validation for the address + floor form.
//
// This is a *cheap client-side gate*, not the source of truth for "is this NYC."
// The authoritative NYC check happens against the NYC Planning GeoSearch API
// (which only indexes NYC addresses) in geocode.ts. This module exists to give
// immediate, friendly feedback before a network call, and to normalize input.

/** WGS84 bounding box for the five boroughs (generous, incl. Staten Island). */
export const NYC_BBOX = {
  minLat: 40.4774,
  maxLat: 40.9176,
  minLng: -74.2591,
  maxLng: -73.7004,
} as const;

/** Returns true if a lat/lng falls inside the NYC bounding box. */
export function isWithinNyc(lat: number, lng: number): boolean {
  return (
    lat >= NYC_BBOX.minLat &&
    lat <= NYC_BBOX.maxLat &&
    lng >= NYC_BBOX.minLng &&
    lng <= NYC_BBOX.maxLng
  );
}

export interface AddressValidation {
  valid: boolean;
  /** Trimmed / collapsed-whitespace form to send downstream. */
  normalized: string;
  error?: string;
}

/**
 * Validates the free-text address field. We require a house number + street
 * name shape ("<number> <words>") because GeoSearch resolves poorly on bare
 * neighborhood names, and the app is explicitly address-level, not area-level.
 */
export function validateAddress(raw: string): AddressValidation {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return { valid: false, normalized, error: "Enter a NYC street address." };
  }
  if (normalized.length < 4) {
    return { valid: false, normalized, error: "That address looks too short." };
  }
  // Require a leading house number so we resolve to a specific building.
  // Queens and parts of the Bronx use hyphenated house numbers ("89-14 Parsons
  // Blvd"), and fractional/lettered numbers exist too ("12A", "1/2"), so the
  // pattern has to allow more than a bare integer — the earlier `^\d+[a-z]?\s`
  // rejected every hyphenated Queens address before it ever reached GeoSearch.
  if (!/^\d+(?:[-/]\d+)?[a-z]?\s+\S+/i.test(normalized)) {
    return {
      valid: false,
      normalized,
      error: "Start with a house number, e.g. “11 Wall St”.",
    };
  }
  return { valid: true, normalized };
}

export const MAX_FLOOR = 130; // taller than any NYC residential building.

export interface FloorValidation {
  valid: boolean;
  floor: number;
  error?: string;
}

/** Validates the floor field: a positive integer within a sane ceiling. */
export function validateFloor(raw: string | number): FloorValidation {
  const n = typeof raw === "number" ? raw : Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) {
    return { valid: false, floor: NaN, error: "Enter a floor number." };
  }
  if (!Number.isInteger(n) || n < 1) {
    return { valid: false, floor: n, error: "Floor must be 1 or higher." };
  }
  if (n > MAX_FLOOR) {
    return {
      valid: false,
      floor: n,
      error: `That's above any NYC building (max ${MAX_FLOOR}).`,
    };
  }
  return { valid: true, floor: n };
}
