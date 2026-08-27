// Address -> lat/lng + BIN via the NYC Planning GeoSearch API.
//
// GeoSearch (https://geosearch.planninglabs.nyc) is a free, key-less Pelias
// instance that ONLY indexes NYC addresses. That property is load-bearing: it
// is our authoritative "is this NYC" gate. An address it can't resolve is, for
// our purposes, not a usable NYC address — and maps to the honest "not
// available" state, never a fabricated location.
//
// Docs: https://geosearch.planninglabs.nyc/docs/

import type { GeocodeResult } from "./types";
import { verifyAddressMatch, type ParsedQuery } from "./addressMatch";

const GEOSEARCH_URL = "https://geosearch.planninglabs.nyc/v2/search";

/** WGS84 bounding box for the five boroughs (generous, incl. Staten Island). */
export const NYC_BBOX = {
  minLat: 40.4774,
  maxLat: 40.9176,
  minLng: -74.2591,
  maxLng: -73.7004,
} as const;

/** True if a lat/lng falls inside the NYC bounding box. */
export function isWithinNyc(lat: number, lng: number): boolean {
  return (
    lat >= NYC_BBOX.minLat &&
    lat <= NYC_BBOX.maxLat &&
    lng >= NYC_BBOX.minLng &&
    lng <= NYC_BBOX.maxLng
  );
}

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
 * How many times to ask before concluding the service is down.
 *
 * Three attempts over ~1 s. GeoSearch sits behind a load balancer that returns
 * 503 with no body when it has no healthy backend, and a single unlucky
 * request hitting a rolling restart used to be indistinguishable from an
 * outage. With the whole host at 503 all three attempts fail in about a second
 * and the caller gets its answer promptly.
 */
const ATTEMPTS = 3;
const BACKOFF_MS = [200, 700];

/**
 * Geocode a NYC address. Throws GeocodeError with a discriminating `kind` on
 * any failure so the pipeline can route every branch to the honest unavailable
 * state. Only transport-level trouble is retried: asking a healthy service the
 * same unanswerable question three times is just three times the wait.
 */
export async function geocodeAddress(
  address: string,
  signal?: AbortSignal,
): Promise<GeocodeResult> {
  let last: GeocodeError | undefined;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      return await geocodeOnce(address, signal);
    } catch (err) {
      if (!(err instanceof GeocodeError) || err.kind !== "network-error") {
        throw err;
      }
      last = err;
      const wait = BACKOFF_MS[attempt];
      if (wait === undefined) break;
      await sleep(wait, signal);
    }
  }
  throw (
    last ??
    new GeocodeError("Could not reach the NYC address service.", "network-error")
  );
}

/** Sleep that still honours an abort, so cancelling a lookup cancels promptly. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function geocodeOnce(
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
    throw new GeocodeError(
      "Malformed response from address service.",
      "network-error",
    );
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
  // is the address that was typed — see lib/addressMatch.ts for why this is
  // not optional. A silent fuzzy substitution would render real imagery of the
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
