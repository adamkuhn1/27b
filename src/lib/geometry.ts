// Camera geometry: turn real building data into four real camera vantages.
//
// This module is the mathematical heart of the "geometry is real" guarantee and
// is fully unit-tested. It does three things, all pure:
//   1. estimate the eye elevation for a floor (height-only framing),
//   2. compute the cardinal headings,
//   3. offset the camera just outside the facade so the view starts at the
//      window plane, not inside the building mesh.
//
// It never invents a scene — it only decides where a camera sits inside Google's
// real photogrammetric reconstruction of NYC.

import {
  CARDINALS,
  CARDINAL_HEADING,
  type BuildingFootprint,
  type CameraView,
} from "./types";

/**
 * Assumed floor-to-floor height, meters. NYC Building Footprints carry no
 * per-floor field (documented in research/27b-imagery.md §1), so we estimate.
 * 3.2 m is a middle-of-road residential floor-to-floor height. This is the
 * single approximation that makes "height-only vertical framing" work, and the
 * reason the UI copy always says "approximately what you'd see."
 */
export const ASSUMED_FLOOR_HEIGHT_M = 3.2;

/** Height of the eye above the floor slab (a standing person at a window). */
export const EYE_ABOVE_FLOOR_M = 1.5;

/**
 * How far outside the facade to push the camera, meters. Enough to clear the
 * building's own mesh so the near geometry doesn't fill the frame, small enough
 * that the vantage is still "from this building."
 */
export const FACADE_OFFSET_M = 6;

const EARTH_RADIUS_M = 6_378_137; // WGS84 equatorial radius.

export interface FloorElevation {
  /** Eye elevation, meters above sea level. */
  eyeElevationM: number;
  /** True when the requested floor exceeded the roof and was clamped. */
  clampedToRoof: boolean;
}

/**
 * Estimate eye elevation (above sea level) for a floor.
 *
 * floor 1 sits at ground; each floor above adds ASSUMED_FLOOR_HEIGHT_M. The eye
 * is EYE_ABOVE_FLOOR_M above the slab. The result is clamped so it can never
 * exceed the real roof height — we refuse to place a camera above a building
 * that isn't that tall, which would fabricate a vantage that doesn't exist.
 */
export function estimateFloorElevation(
  footprint: BuildingFootprint,
  floor: number,
): FloorElevation {
  const floorSlabAboveGround = (floor - 1) * ASSUMED_FLOOR_HEIGHT_M;
  const eyeAboveGround = floorSlabAboveGround + EYE_ABOVE_FLOOR_M;

  // Clamp to the real roof: never look out from above the actual building.
  const roof = footprint.roofHeightM;
  const clampedToRoof = eyeAboveGround > roof && roof > 0;
  const cappedAboveGround = clampedToRoof ? roof : eyeAboveGround;

  return {
    eyeElevationM: footprint.groundElevationM + cappedAboveGround,
    clampedToRoof,
  };
}

/** Degrees → radians. */
function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Offset a lat/lng by a distance (meters) along a compass heading.
 * Equirectangular approximation — accurate to well under a meter at the tens of
 * meters we use, which is far finer than the tile mesh resolution.
 */
export function offsetLatLng(
  lat: number,
  lng: number,
  headingDeg: number,
  distanceM: number,
): { lat: number; lng: number } {
  const bearing = toRad(headingDeg);
  const dNorth = distanceM * Math.cos(bearing);
  const dEast = distanceM * Math.sin(bearing);

  const dLat = (dNorth / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLng =
    (dEast / (EARTH_RADIUS_M * Math.cos(toRad(lat)))) * (180 / Math.PI);

  return { lat: lat + dLat, lng: lng + dLng };
}

/**
 * Build the four cardinal camera views for a footprint at a given eye
 * elevation. Each camera is pushed FACADE_OFFSET_M outward from the centroid in
 * its own heading, so it looks *away* from the building toward the horizon.
 */
export function buildCameraViews(
  footprint: BuildingFootprint,
  eyeElevationM: number,
): CameraView[] {
  return CARDINALS.map((cardinal) => {
    const headingDeg = CARDINAL_HEADING[cardinal];
    const { lat, lng } = offsetLatLng(
      footprint.centroid.lat,
      footprint.centroid.lng,
      headingDeg,
      FACADE_OFFSET_M,
    );
    return {
      cardinal,
      headingDeg,
      lat,
      lng,
      heightM: eyeElevationM,
      pitchDeg: 0, // look at the horizon; height-only framing, no parallax tilt.
    };
  });
}

/**
 * Compute the centroid of a footprint polygon ring (GeoJSON [lng, lat] pairs).
 * Uses the area-weighted centroid so concave/L-shaped footprints resolve to a
 * point inside the polygon rather than a vertex average.
 */
export function polygonCentroid(
  ring: Array<[number, number]>,
): { lat: number; lng: number } {
  if (ring.length === 0) {
    throw new Error("polygonCentroid: empty ring");
  }
  // Drop a duplicated closing vertex if present.
  const pts =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring;

  if (pts.length < 3) {
    // Degenerate: average the available points.
    const sum = pts.reduce(
      (acc, [lng, lat]) => ({ lng: acc.lng + lng, lat: acc.lat + lat }),
      { lng: 0, lat: 0 },
    );
    return { lng: sum.lng / pts.length, lat: sum.lat / pts.length };
  }

  let areaSum = 0;
  let cxSum = 0;
  let cySum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    const cross = x0 * y1 - x1 * y0;
    areaSum += cross;
    cxSum += (x0 + x1) * cross;
    cySum += (y0 + y1) * cross;
  }
  const area = areaSum / 2;
  if (Math.abs(area) < 1e-12) {
    // Collinear / zero-area: fall back to vertex mean.
    const sum = pts.reduce(
      (acc, [lng, lat]) => ({ lng: acc.lng + lng, lat: acc.lat + lat }),
      { lng: 0, lat: 0 },
    );
    return { lng: sum.lng / pts.length, lat: sum.lat / pts.length };
  }
  return { lng: cxSum / (6 * area), lat: cySum / (6 * area) };
}
