import { describe, it, expect } from "vitest";
import { parseFootprint, FootprintError } from "./footprint";

const FT_TO_M = 0.3048;

const polygonGeom = {
  type: "Polygon",
  coordinates: [
    [
      [-74.006, 40.7128],
      [-74.006, 40.7130],
      [-74.004, 40.7130],
      [-74.004, 40.7128],
      [-74.006, 40.7128],
    ],
  ],
};

describe("parseFootprint", () => {
  it("converts feet to meters for roof height and ground elevation", () => {
    const fp = parseFootprint(
      { bin: "1012345", height_roof: "300", ground_elevation: "40", the_geom: polygonGeom },
      "1012345",
    );
    expect(fp.roofHeightM).toBeCloseTo(300 * FT_TO_M, 6);
    expect(fp.groundElevationNavd88M).toBeCloseTo(40 * FT_TO_M, 6);
    expect(fp.bin).toBe("1012345");
  });

  it("computes a centroid inside the footprint", () => {
    const fp = parseFootprint(
      { bin: "1012345", height_roof: "300", ground_elevation: "40", the_geom: polygonGeom },
      "1012345",
    );
    expect(fp.centroid.lng).toBeGreaterThan(-74.006);
    expect(fp.centroid.lng).toBeLessThan(-74.004);
    expect(fp.centroid.lat).toBeGreaterThan(40.7128);
    expect(fp.centroid.lat).toBeLessThan(40.713);
  });

  it("handles MultiPolygon geometry by using the first ring", () => {
    const multi = {
      type: "MultiPolygon",
      coordinates: [polygonGeom.coordinates],
    };
    const fp = parseFootprint(
      { bin: "2", height_roof: "120", ground_elevation: "5", the_geom: multi },
      "2",
    );
    expect(fp.roofHeightM).toBeCloseTo(120 * FT_TO_M, 6);
    expect(fp.centroid.lng).toBeLessThan(-74.004);
  });

  it("defaults ground elevation to 0 when missing (waterline buildings)", () => {
    const fp = parseFootprint(
      { bin: "3", height_roof: "80", the_geom: polygonGeom },
      "3",
    );
    expect(fp.groundElevationNavd88M).toBe(0);
  });

  it("refuses (no-footprint) when roof height is missing", () => {
    expect(() =>
      parseFootprint({ bin: "4", ground_elevation: "10", the_geom: polygonGeom }, "4"),
    ).toThrowError(FootprintError);
  });

  it("refuses (no-footprint) when roof height is zero or negative", () => {
    expect(() =>
      parseFootprint(
        { bin: "5", height_roof: "0", ground_elevation: "10", the_geom: polygonGeom },
        "5",
      ),
    ).toThrowError(FootprintError);
  });

  it("refuses (no-footprint) when geometry is missing rather than inventing one", () => {
    expect(() =>
      parseFootprint({ bin: "6", height_roof: "90", ground_elevation: "10" }, "6"),
    ).toThrowError(FootprintError);
  });

  it("tags refusals with the no-footprint kind for honest routing", () => {
    try {
      parseFootprint({ bin: "7", ground_elevation: "10", the_geom: polygonGeom }, "7");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FootprintError);
      expect((e as FootprintError).kind).toBe("no-footprint");
    }
  });
});
