#!/usr/bin/env node
// Capture live GeoSearch answers for the landing-page presets.
//
// WHY THIS EXISTS. On 2026-08-08 geosearch.planninglabs.nyc — the free, keyless
// NYC Planning service that every 27B lookup starts with — went to 503 across
// every endpoint and stayed there. With it down the app cannot resolve a single
// address, so all five preset buttons return "Something went wrong". The
// presets are the demo; almost nobody types an address into a portfolio piece.
// Losing them to somebody else's outage is not acceptable.
//
// So the five preset buildings carry a committed record of what the live
// service actually returned for them, used only when the live service is
// unreachable. See src/lib/knownAddresses.ts.
//
// WHAT THIS SCRIPT MAY AND MAY NOT DO. It writes ONLY what the live service
// returns, verbatim, for the exact query strings the preset buttons submit. It
// does not derive coordinates from footprint geometry, does not copy them from
// another provider, and does not fill a gap with a plausible number. If the
// service is down, it writes nothing and says so — a partial table is fine, an
// invented one is not.
//
//   node apps/27b/proof/capture-known-addresses.mjs           # refresh all
//   node apps/27b/proof/capture-known-addresses.mjs --check   # verify, no write

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TABLE = join(HERE, "..", "src", "lib", "knownAddresses.json");
const CHECK = process.argv.includes("--check");

// Exactly the strings apps/27b/src/App.tsx submits. Kept in step by
// src/lib/knownAddresses.test.ts, which fails if App.tsx grows a preset this
// list does not have.
const ADDRESSES = [
  "425 E 79th St, Manhattan, New York, NY 10075",
  "1 W 72nd St, Manhattan, New York, NY 10023",
  "432 Park Ave, Manhattan, New York, NY 10022",
  "175 5th Ave, Manhattan, New York, NY 10010",
  "350 5th Ave, Manhattan, New York, NY 10118",
];

const URL_BASE = "https://geosearch.planninglabs.nyc/v2/search";

async function capture(address) {
  const url = `${URL_BASE}?text=${encodeURIComponent(address)}&size=1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const f = data.features?.[0];
  if (!f) throw new Error("no feature returned");
  const [lng, lat] = f.geometry.coordinates;
  const binRaw = f.properties.addendum?.pad?.bin;
  const bin = binRaw != null && String(binRaw).trim() !== "" ? String(binRaw) : undefined;
  if (!bin) throw new Error("no BIN — the record would be useless to the pipeline");
  return {
    label: f.properties.label ?? f.properties.name ?? address,
    lat,
    lng,
    bin,
    borough: f.properties.borough,
  };
}

const existing = (() => {
  try {
    return JSON.parse(readFileSync(TABLE, "utf8"));
  } catch {
    return { _: "", records: {} };
  }
})();

const records = { ...existing.records };
let captured = 0;
let unchanged = 0;
let failed = 0;
const drift = [];

for (const address of ADDRESSES) {
  try {
    const got = await capture(address);
    const had = records[address];
    if (had && (had.lat !== got.lat || had.lng !== got.lng || had.bin !== got.bin)) {
      drift.push({ address, had: { lat: had.lat, lng: had.lng, bin: had.bin }, got });
    }
    if (!CHECK) {
      records[address] = { ...got, capturedAt: new Date().toISOString().slice(0, 10) };
    }
    captured += 1;
    console.error(`  ok      ${address}  ->  ${got.label}  BIN ${got.bin}`);
  } catch (err) {
    failed += 1;
    if (records[address]) {
      unchanged += 1;
      console.error(`  KEPT    ${address}  (live: ${err.message}; existing record retained)`);
    } else {
      console.error(`  MISSING ${address}  (live: ${err.message}; no record to fall back on)`);
    }
  }
}

if (drift.length > 0) {
  console.error(`\n[known] ${drift.length} record(s) DRIFTED from the live service:`);
  for (const d of drift) console.error(`  ${d.address}\n    had ${JSON.stringify(d.had)}\n    now ${JSON.stringify({ lat: d.got.lat, lng: d.got.lng, bin: d.got.bin })}`);
}

if (CHECK) {
  console.error(`\n[known] check only — nothing written.`);
  process.exit(drift.length > 0 ? 1 : 0);
}

const out = {
  _: "What NYC Planning GeoSearch actually returned for the landing-page presets. Used ONLY as a fallback when the live service is unreachable — see src/lib/knownAddresses.ts. Written exclusively by proof/capture-known-addresses.mjs from live responses; never hand-edited, never derived.",
  source: URL_BASE,
  records,
};
writeFileSync(TABLE, JSON.stringify(out, null, 2) + "\n");

const have = Object.keys(records).length;
console.error(
  `\n[known] ${captured} captured, ${unchanged} retained, ${failed} unavailable — ` +
    `${have}/${ADDRESSES.length} preset(s) have a record.\n[known] wrote ${TABLE}`,
);
if (have < ADDRESSES.length) {
  console.error(
    `[known] INCOMPLETE. Re-run when geosearch.planninglabs.nyc is back up; the presets\n` +
      `        without a record still depend on it being reachable.`,
  );
}
