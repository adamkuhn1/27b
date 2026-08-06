#!/usr/bin/env node
// Capture real NYC Open Data footprints as offline test fixtures.
//
// The confidence layer (src/lib/confidence.ts) is calibrated against four real
// buildings whose imagery was independently described in
// docs/repair/release-candidate/27b/REPORT.md §7. Its unit tests must run
// offline and deterministically, so the input data is captured once, here, and
// committed.
//
// COST: $0.00. Two free, keyless services are used — NYC Planning GeoSearch and
// NYC Open Data (Socrata). No Google endpoint is contacted, no API key is read,
// and no imagery of any kind is fetched or stored. There is nothing in the
// output but public municipal geometry.
//
// The neighbour query deliberately uses `intersects()` with a WKT box rather
// than `within_circle()`. On a polygon column `within_circle` means "the
// polygon lies ENTIRELY inside the circle", so it silently drops every large
// neighbour that straddles the radius — exactly the buildings that block a
// view. This script records both results for the Empire State Building so the
// difference is evidence rather than a claim; see
// docs/repair/personal-authorship-sprint/evidence/27b-soql-within-circle.json.
//
// Usage:  node apps/27b/proof/make-confidence-fixtures.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "src", "lib", "__fixtures__");
const EVIDENCE_DIR = join(
  HERE,
  "..",
  "..",
  "..",
  "docs",
  "repair",
  "personal-authorship-sprint",
  "evidence",
);

const SODA = "https://data.cityofnewyork.us/resource/5zhs-2jue.json";
const GEOSEARCH = "https://geosearch.planninglabs.nyc/v2/search";
const SEARCH_RADIUS_M = 220;
const M_PER_DEG_LAT = 111_320;

/** Buildings whose four directions the proof package already characterized. */
const CASES = [
  { name: "esb", address: "350 5th Ave, Manhattan, New York, NY 10118" },
  { name: "flatiron", address: "175 5th Ave, Manhattan, New York, NY 10010" },
  { name: "e79", address: "425 E 79th St, Manhattan, New York, NY 10075" },
  { name: "dakota", address: "1 W 72nd St, Manhattan, New York, NY 10023" },
];

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function binFor(address) {
  const data = await getJson(
    `${GEOSEARCH}?text=${encodeURIComponent(address)}&size=1`,
  );
  const props = data?.features?.[0]?.properties;
  if (!props) throw new Error(`no geocode result for ${address}`);
  const bin = props.addendum?.pad?.bin ?? props.pad_bin;
  if (!bin) throw new Error(`no BIN for ${address} (${props.label})`);
  return { bin: String(bin), label: props.label };
}

function wktBox(lat, lng, radiusM) {
  const dLat = radiusM / M_PER_DEG_LAT;
  const dLng = radiusM / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  const s = (lat - dLat).toFixed(7);
  const n = (lat + dLat).toFixed(7);
  const w = (lng - dLng).toFixed(7);
  const e = (lng + dLng).toFixed(7);
  return `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`;
}

/** Area-weighted centroid of a [lng,lat] ring — same math as geometry.ts. */
function centroid(ring) {
  const pts =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring;
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  const area = a / 2;
  return { lng: cx / (6 * area), lat: cy / (6 * area) };
}

function outerRing(geom) {
  if (!geom) return null;
  const ring =
    geom.type === "MultiPolygon" ? geom.coordinates?.[0]?.[0] : geom.coordinates?.[0];
  return Array.isArray(ring) && ring.length >= 3 ? ring : null;
}

/** Keep only the fields the app reads, at 6 dp (~0.1 m). Keeps fixtures small. */
function trim(row) {
  const ring = outerRing(row.the_geom);
  if (!ring) return null;
  const out = {
    bin: row.bin,
    the_geom: {
      type: "Polygon",
      coordinates: [ring.map(([x, y]) => [Number(x.toFixed(6)), Number(y.toFixed(6))])],
    },
  };
  // Preserved as strings exactly as SODA returns them — including ABSENCE,
  // which is a distinct case the parser has to handle (see neighbors.ts).
  if (row.height_roof !== undefined) out.height_roof = row.height_roof;
  if (row.ground_elevation !== undefined) out.ground_elevation = row.ground_elevation;
  return out;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const manifest = [];

  for (const kase of CASES) {
    const { bin, label } = await binFor(kase.address);
    const [subjectRow] = await getJson(
      `${SODA}?$where=${encodeURIComponent(`bin='${bin}'`)}&$limit=1`,
    );
    if (!subjectRow) throw new Error(`no footprint for BIN ${bin}`);
    const c = centroid(outerRing(subjectRow.the_geom));

    const where = `intersects(the_geom,'${wktBox(c.lat, c.lng, SEARCH_RADIUS_M)}')`;
    const rows = await getJson(
      `${SODA}?$select=${encodeURIComponent(
        "bin,height_roof,ground_elevation,the_geom",
      )}&$where=${encodeURIComponent(where)}&$limit=1500`,
    );

    const fixture = {
      _source:
        "NYC Open Data Building Footprints (5zhs-2jue) + NYC Planning GeoSearch. Free, keyless, public. Captured by proof/make-confidence-fixtures.mjs.",
      _capturedAt: new Date().toISOString().slice(0, 10),
      _note:
        "Coordinates rounded to 6 decimal places (~0.1 m). No provider imagery of any kind is present in this file.",
      address: kase.address,
      geocodeLabel: label,
      bin,
      subject: trim(subjectRow),
      neighbors: rows.map(trim).filter(Boolean),
    };
    // Written compact on purpose. Pretty-printing 200 polygons puts ~13,000
    // lines of coordinates per building into the repo, which dwarfs every real
    // change in a diffstat without making a single number more reviewable.
    // These are machine inputs; the reviewable artifact is the calibration
    // table the tests print from them.
    const file = join(OUT_DIR, `${kase.name}.json`);
    writeFileSync(file, `${JSON.stringify(fixture)}\n`);
    manifest.push({
      name: kase.name,
      bin,
      label,
      neighbors: fixture.neighbors.length,
      bytes: JSON.stringify(fixture).length,
    });
    console.log(
      `${kase.name}: BIN ${bin} · ${fixture.neighbors.length} neighbours · ${label}`,
    );
  }

  // The within_circle vs intersects difference, measured rather than asserted.
  const esb = JSON.parse(
    // re-read what we just wrote so the recorded centroid is the committed one
    (await import("node:fs")).readFileSync(join(OUT_DIR, "esb.json"), "utf8"),
  );
  const c = centroid(esb.subject.the_geom.coordinates[0]);
  const probe = async (where) =>
    (await getJson(`${SODA}?$select=bin&$where=${encodeURIComponent(where)}&$limit=1500`))
      .length;
  const r40 = await probe(`within_circle(the_geom,${c.lat},${c.lng},40)`);
  const r150 = await probe(`within_circle(the_geom,${c.lat},${c.lng},150)`);
  const box = await probe(
    `intersects(the_geom,'${wktBox(c.lat, c.lng, SEARCH_RADIUS_M)}')`,
  );
  writeFileSync(
    join(EVIDENCE_DIR, "27b-soql-within-circle.json"),
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString().slice(0, 10),
        endpoint: SODA,
        cost: "$0.00 — free, keyless NYC Open Data",
        centre: c,
        finding:
          "within_circle() on a polygon column means 'entirely contained', not 'intersects'. The Empire State Building's own footprint is excluded from a 40 m circle centred on its own centroid, because its half-diagonal is about 96 m. Any obstruction analysis built on within_circle() therefore silently omits the large adjacent towers that matter most.",
        rows: {
          "within_circle r=40": r40,
          "within_circle r=150": r150,
          [`intersects ${SEARCH_RADIUS_M} m box`]: box,
        },
        pinnedBy: "apps/27b/src/lib/neighbors.test.ts",
      },
      null,
      2,
    )}\n`,
  );
  console.log("\nwithin_circle r=40:", r40, "· r=150:", r150, "· intersects box:", box);
  console.log("\nmanifest:", JSON.stringify(manifest, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
