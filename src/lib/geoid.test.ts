import { describe, it, expect } from "vitest";
import { geoidHeightM } from "./geoid";

/**
 * Ground truth sampled from NOAA NGS's Geoid Height Service (GEOID18) on
 * 2026-08-04: https://geodesy.noaa.gov/api/geoid/ght?lat=<lat>&lon=<lon>
 *
 * These are independent of the lattice baked into geoid.ts (none of them is a
 * lattice node), so they measure real interpolation error, not self-consistency.
 */
const NOAA_SAMPLES: Array<[string, number, number, number]> = [
  ["Empire State Building", 40.7484, -73.9857, -31.752],
  ["One World Trade Center", 40.7127, -74.0134, -31.872],
  ["432 Park Avenue", 40.7616, -73.9718, -31.698],
  ["Bed-Stuy, Brooklyn", 40.6782, -73.9442, -31.813],
  ["Jamaica, Queens", 40.7282, -73.7949, -31.551],
  ["The Bronx", 40.8448, -73.8648, -31.336],
  ["Staten Island", 40.5795, -74.1502, -32.264],
  ["Upper East Side", 40.7794, -73.9632, -31.653],
];

describe("geoidHeightM (GEOID18 over NYC)", () => {
  it.each(NOAA_SAMPLES)(
    "matches NOAA within 5 cm at %s",
    (_name, lat, lng, truth) => {
      expect(Math.abs(geoidHeightM(lat, lng) - truth)).toBeLessThan(0.05);
    },
  );

  it("is negative everywhere in NYC (ellipsoid sits above the geoid here)", () => {
    for (const [, lat, lng] of NOAA_SAMPLES) {
      expect(geoidHeightM(lat, lng)).toBeLessThan(-30);
      expect(geoidHeightM(lat, lng)).toBeGreaterThan(-34);
    }
  });

  it("clamps rather than extrapolating outside the lattice", () => {
    const inside = geoidHeightM(40.4, -74.3);
    const outside = geoidHeightM(39.0, -76.0);
    expect(outside).toBeCloseTo(inside, 9);
  });
});

