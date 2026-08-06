// Load a captured NYC Open Data fixture as the objects the app works with.
//
// The JSON in this folder is real municipal geometry captured once by
// proof/make-confidence-fixtures.mjs from two free, keyless endpoints. It
// contains no provider imagery and nothing derived from any. Tests run against
// it offline, so no test in this repo touches the network.

import { parseFootprint } from "../footprint";
import { parseNeighbors } from "../neighbors";
import { estimateFloorElevation, buildCameraViews } from "../geometry";
import type { BuildingFootprint, CameraView, NeighborBuilding } from "../types";

export interface RawFixture {
  address: string;
  geocodeLabel: string;
  bin: string;
  subject: {
    bin?: string;
    height_roof?: string;
    ground_elevation?: string;
    the_geom: { type: string; coordinates: number[][][] };
  };
  neighbors: Array<{
    bin?: string;
    height_roof?: string;
    ground_elevation?: string;
    the_geom: { type: string; coordinates: number[][][] };
  }>;
}

export interface LoadedCase {
  bin: string;
  footprint: BuildingFootprint;
  neighbors: NeighborBuilding[];
  neighborDataIncomplete: boolean;
  views: CameraView[];
  eyeElevationNavd88M: number;
  facadeConcentration: number;
  floorClampedToRoof: boolean;
}

/** Run the real geometry pipeline over a fixture at a given floor. */
export function loadCase(raw: RawFixture, floor: number): LoadedCase {
  const footprint = parseFootprint(raw.subject, raw.bin);
  const elevation = estimateFloorElevation(footprint, floor);
  const { views, concentration } = buildCameraViews(
    footprint,
    elevation.eyeElevationEllipsoidalM,
    elevation.eyeElevationNavd88M - footprint.groundElevationNavd88M,
  );
  const { neighbors, incomplete } = parseNeighbors(raw.neighbors);
  return {
    bin: raw.bin,
    footprint,
    neighbors,
    neighborDataIncomplete: incomplete,
    views,
    eyeElevationNavd88M: elevation.eyeElevationNavd88M,
    facadeConcentration: concentration,
    floorClampedToRoof: elevation.clampedToRoof,
  };
}
