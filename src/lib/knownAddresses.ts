// A last resort for when the NYC address service is down.
//
// 27B begins every lookup at geosearch.planninglabs.nyc, a free, keyless,
// unauthenticated NYC Planning service. It is the right primary source — it is
// the authority, it is the NYC gate, and it is the only one of our sources that
// returns a BIN. It is also a single point of failure with no SLA, and on
// 2026-08-08 it returned 503 from every endpoint for an extended period. While
// it was down the app could not resolve one address, so all five preset buttons
// on the landing page returned "Something went wrong". Those buttons are how
// essentially everyone will see this app.
//
// So the presets carry a record of what the live service returned for them.
//
// WHAT THIS IS NOT. It is not a geocoder, not a cache, and not a guess. The
// numbers were captured off the wire from the live service by
// proof/capture-known-addresses.mjs and are stored verbatim; nothing here is
// derived from footprint geometry or from any other provider. It is consulted
// only after the live service has been tried and has failed with a *service*
// error — never when the service answered. A "we couldn't find that address"
// or "that resolved outside NYC" is a real answer and it stands.
//
// The result is marked `fromRecord`, with the capture date, and the UI says so.
// A visitor is never shown a stale coordinate presented as a fresh lookup.
//
// A building's BIN and its front door do not move, so a record going stale is a
// slow, visible kind of wrong rather than a silent one — and
// `capture-known-addresses.mjs --check` compares every record against the live
// service and exits non-zero on drift.

import knownAddresses from "./knownAddresses.json";
import type { GeocodeResult } from "./types";

interface KnownRecord {
  label: string;
  lat: number;
  lng: number;
  bin: string;
  borough?: string;
  /** ISO date the live service was asked. */
  capturedAt: string;
  /** Present when the record was lifted out of an earlier committed run. */
  via?: string;
}

const RECORDS = knownAddresses.records as Record<string, KnownRecord>;

/** Same normalisation the preset buttons and the form both end up producing. */
const key = (address: string) => address.trim().toLowerCase().replace(/\s+/g, " ");

const BY_KEY = new Map(Object.entries(RECORDS).map(([addr, rec]) => [key(addr), rec]));

export interface RecordedGeocode extends GeocodeResult {
  bin: string;
  /** Always true. Its presence is what the UI keys its disclosure off. */
  fromRecord: true;
  /** ISO date the live service was asked for this building. */
  recordedAt: string;
}

/**
 * The committed record for an address, if there is one.
 *
 * Callers must only reach this after a service-level failure. There is
 * deliberately no `force` parameter: an easy way to prefer the record over the
 * live service is an easy way to end up shipping the record.
 */
export function recordedGeocode(address: string): RecordedGeocode | undefined {
  const rec = BY_KEY.get(key(address));
  if (!rec) return undefined;
  return {
    label: rec.label,
    lat: rec.lat,
    lng: rec.lng,
    bin: rec.bin,
    borough: rec.borough,
    fromRecord: true,
    recordedAt: rec.capturedAt,
  };
}

/** Every address that has a record. Used by the tests and by the capture script. */
export function recordedAddresses(): string[] {
  return Object.keys(RECORDS);
}
