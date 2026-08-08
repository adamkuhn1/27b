// The committed-record fallback, and the rules it must not break.
//
// The risk this file guards is not that the fallback fails to work — that shows
// up immediately. It is that the fallback works too well: that it starts
// answering questions the live service already answered, or that a coordinate
// nobody captured finds its way into the table. Either turns an honest outage
// mitigation into the app quietly making things up.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, afterEach } from "vitest";
import { geocodeAddress, GeocodeError } from "./geocode";
import { recordedGeocode, recordedAddresses } from "./knownAddresses";
import { isWithinNyc } from "./validation";

const APP = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, APP)), "utf8");

const RECORDED = "425 E 79th St, Manhattan, New York, NY 10075";

afterEach(() => vi.unstubAllGlobals());

const stubFetch = (impl: () => Promise<Response> | never) =>
  vi.stubGlobal("fetch", vi.fn(impl));

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("the committed records themselves", () => {
  it("are all in New York City and all carry a BIN", () => {
    const addresses = recordedAddresses();
    expect(addresses.length).toBeGreaterThan(0);
    for (const address of addresses) {
      const rec = recordedGeocode(address);
      expect(rec, address).toBeDefined();
      expect(isWithinNyc(rec!.lat, rec!.lng), address).toBe(true);
      // No BIN means the pipeline cannot join to a footprint, so a record
      // without one would fall back to a result that fails one step later.
      expect(rec!.bin, address).toMatch(/^\d+$/);
      expect(rec!.recordedAt, address).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("covers addresses the preset buttons actually submit", () => {
    // A record for an address no button sends is dead weight; a button with no
    // record is a preset that still dies in an outage. Neither is caught by
    // anything else, because the two lists live in different files.
    const app = read("src/App.tsx");
    const submitted = [...app.matchAll(/address:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(submitted.length).toBeGreaterThan(0);
    const covered = submitted.filter((a) => recordedGeocode(a));
    expect(covered.length, `presets without a record: ${submitted.filter((a) => !recordedGeocode(a)).join(", ")}`)
      .toBe(submitted.length);
  });

  it("is written only by the capture script, which only writes live responses", () => {
    const script = read("proof/capture-known-addresses.mjs");
    expect(script).toContain("geosearch.planninglabs.nyc");
    // The script must never manufacture a coordinate to fill a gap. If the
    // service is down for an address with no record, the record stays missing.
    expect(script).toContain("MISSING");
    // Every value it writes comes out of the parsed live response and nothing
    // else. If it ever grows a second source of coordinates — a footprint
    // centroid, another provider, a hand-maintained list — this is where that
    // would show up, as an import.
    const imports = [...script.matchAll(/^import .*$/gm)].map((m) => m[0]);
    expect(imports.join("\n")).not.toMatch(/footprint|geometry|soda|fixtures/i);
  });
});

describe("when the live service is unreachable", () => {
  it("falls back to the record", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const got = await geocodeAddress(RECORDED);
    expect(got.fromRecord).toBe(true);
    expect(got.bin).toBe("1050349");
    expect(got.label).toBe("425 EAST 79 STREET, New York, NY, USA");
  });

  it("falls back on a 503, which is the failure that actually happened", async () => {
    stubFetch(() => Promise.resolve(new Response("<h1>503</h1>", { status: 503 })));
    await expect(geocodeAddress(RECORDED)).resolves.toMatchObject({ fromRecord: true });
  });

  it("retries before giving up, and stops retrying", async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return Promise.resolve(new Response("", { status: 503 }));
    });
    await geocodeAddress(RECORDED);
    expect(calls).toBe(3);
  });

  it("succeeds live on a retry rather than reaching for the record", async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(new Response("", { status: 503 }));
      return Promise.resolve(ok(peliasFor("425", "EAST 79 STREET")));
    });
    const got = await geocodeAddress(RECORDED);
    expect(got.fromRecord).toBeUndefined();
    expect(calls).toBe(2);
  });

  it("still fails, honestly, for an address with no record", async () => {
    stubFetch(() => Promise.resolve(new Response("", { status: 503 })));
    await expect(geocodeAddress("1 Nowhere Pl, Manhattan, New York, NY 10001"))
      .rejects.toMatchObject({ kind: "network-error" });
  });
});

describe("when the live service answers", () => {
  it("does not consult the record for an address it could not find", async () => {
    // The dangerous version of this feature answers "not found" out of the
    // table. GeoSearch saying no is a real answer about the real world.
    stubFetch(() => Promise.resolve(ok({ features: [] })));
    await expect(geocodeAddress(RECORDED)).rejects.toBeInstanceOf(GeocodeError);
    await expect(geocodeAddress(RECORDED)).rejects.toMatchObject({ kind: "geocode-failed" });
  });

  it("asks exactly once when the answer is a real no", async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return Promise.resolve(ok({ features: [] }));
    });
    await expect(geocodeAddress(RECORDED)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("prefers the live answer over the record when both exist", async () => {
    stubFetch(() => Promise.resolve(ok(peliasFor("425", "EAST 79 STREET"))));
    const got = await geocodeAddress(RECORDED);
    expect(got.fromRecord).toBeUndefined();
  });
});

/** A minimal Pelias response the real parser accepts for 425 E 79th St. */
function peliasFor(housenumber: string, street: string) {
  return {
    geocoding: { query: { parsed_text: { housenumber, street: "E 79TH ST", borough: "Manhattan" } } },
    features: [
      {
        geometry: { coordinates: [-73.951304, 40.772038] },
        properties: {
          label: `${housenumber} ${street}, New York, NY, USA`,
          housenumber,
          street,
          borough: "Manhattan",
          region_a: "NY",
          addendum: { pad: { bin: "1050349" } },
        },
      },
    ],
  };
}
