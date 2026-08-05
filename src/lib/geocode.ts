// Address -> lat/lng + BIN via the NYC Planning GeoSearch API.
//
// GeoSearch (https://geosearch.planninglabs.nyc) is a free, key-less Pelias
// instance that ONLY indexes NYC addresses. That property is load-bearing: it is
// our authoritative "is this NYC" gate. An address it can't resolve is, for our
// purposes, not a usable NYC address — and maps to the honest "not available"
// state, never a fabricated location.
//
// Docs: https://geosearch.planninglabs.nyc/docs/

import type { GeocodeResult } from "./types";
import { isWithinNyc } from "./validation";
import { verifyAddressMatch, type ParsedQuery } from "./addressMatch";

const GEOSEARCH_URL =
  "https://geosearch.planninglabs.nyc/v2/search";

/** Minimal shape of the GeoSearch (Pelias) response we consume. */
interface PeliasFeature {
  geometry: { coordinates: [number, number] }; // [lng, lat]
  properties: {
    label?: string;
    name?: string;
    borough?: string;
    housenumber?: string;
    street?: string;
    locality?: string;
    region_a?: string;
    // GeoSearch surfaces NYC identifiers under addendum.pad.
    addendum?: { pad?: { bin?: string | number } };
  };
}

interface PeliasResponse {
  features?: PeliasFeature[];
  /** Pelias echoes its own parse of the query here; we verify against it. */
  geocoding?: { query?: { parsed_text?: ParsedQuery } };
}

export class GeocodeError extends Error {
  constructor(
    message: string,
    readonly kind: "not-nyc" | "geocode-failed" | "network-error",
  ) {
    super(message);
    this.name = "GeocodeError";
  }
}

/**
 * Geocode a NYC address. Throws GeocodeError with a discriminating `kind` on any
 * failure so the pipeline can route every branch to the honest unavailable state.
 */
export async function geocodeAddress(
  address: string,
  signal?: AbortSignal,
): Promise<GeocodeResult> {
  const url = `${GEOSEARCH_URL}?text=${encodeURIComponent(address)}&size=1`;

  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new GeocodeError(
      "Could not reach the NYC address service.",
      "network-error",
    );
  }

  if (!res.ok) {
    throw new GeocodeError(
      `Address service returned ${res.status}.`,
      "network-error",
    );
  }

  let data: PeliasResponse;
  try {
    data = (await res.json()) as PeliasResponse;
  } catch {
    throw new GeocodeError("Malformed response from address service.", "network-error");
  }

  const feature = data.features?.[0];
  if (!feature) {
    throw new GeocodeError(
      "We couldn't find that address in NYC.",
      "geocode-failed",
    );
  }

  const [lng, lat] = feature.geometry.coordinates;

  // GeoSearch is NYC-only, but guard the bbox too: a bad match outside NYC is
  // treated as "not NYC" rather than silently accepted.
  if (!isWithinNyc(lat, lng)) {
    throw new GeocodeError(
      "That address resolved outside New York City.",
      "not-nyc",
    );
  }

  // Pelias always answers with *something*. Verify that the something it found
  // is the address that was typed — see lib/addressMatch.ts for why this is not
  // optional. A silent fuzzy substitution would render real imagery of the
  // wrong building under the user's address, which is a worse lie than a
  // missing image.
  const verdict = verifyAddressMatch(data.geocoding?.query?.parsed_text ?? {}, {
    housenumber: feature.properties.housenumber,
    street: feature.properties.street,
    locality: feature.properties.locality,
    borough: feature.properties.borough,
    region_a: feature.properties.region_a,
    label: feature.properties.label,
  });
  if (!verdict.ok) {
    throw new GeocodeError(verdict.message, verdict.kind);
  }

  const binRaw = feature.properties.addendum?.pad?.bin;
  const bin =
    binRaw != null && String(binRaw).trim() !== "" ? String(binRaw) : undefined;

  return {
    label: feature.properties.label ?? feature.properties.name ?? address,
    lat,
    lng,
    bin,
    borough: feature.properties.borough,
  };
}
