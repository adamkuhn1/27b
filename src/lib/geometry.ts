// Camera geometry: turn real building data into four real camera vantages.
//
// This module is the mathematical heart of the "geometry is real" guarantee and
// is fully unit-tested. It does four things, all pure:
//   1. estimate the eye elevation for a floor, in the source datum (NAVD88) and
//      in the WGS84 ellipsoidal datum the renderer actually consumes,
//   2. find the building's dominant facade orientation from its footprint,
//   3. ray-cast from the centroid to the OUTERMOST facade wall in each of the
//      four view bearings,
//   4. push the camera just outside that wall, and verify it really is outside.
//
// It never invents a scene — it only decides where a camera sits inside Google's
// real photogrammetric reconstruction of NYC.

import {
  VIEW_SLOTS,
  compassLabel,
  type BuildingFootprint,
  type CameraView,
  type ViewBasis,
  type ViewSlot,
} from "./types";
import { geoidHeightM } from "./geoid";

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
 * How far outside the facade to push the camera, meters.
 *
 * Every metre here is spent twice: it buys clearance from the subject
 * building's own photogrammetric mesh (which does not coincide exactly with the
 * municipal footprint), and it *costs* the same metre of separation from
 * whatever the camera is looking AT. In a Manhattan side street the opposing
 * wall is 10-25 m from the subject facade, so a 6 m push removes a quarter to a
 * half of the only distance the frame has. Detail in the provider mesh is
 * roughly fixed in metres per texel, so halving the distance to the subject
 * doubles how much each texel is magnified — which is what "melted" looks like.
 *
 * The value below is the one under test in the rendering bake-off; see
 * docs/repair/portfolio-suite-product-sprint/27b/REPORT.md.
 */
export const FACADE_OFFSET_M = 6;

/**
 * Step used by the escape hatch in `buildCameraViews` when a malformed ring
 * leaves the camera inside the polygon. Deliberately larger than
 * `FACADE_OFFSET_M`: this loop only ever runs for self-intersecting source
 * geometry, where the right move is to get clear quickly rather than to creep.
 */
const RESCUE_STEP_M = 6;

/**
 * Minimum length-weighted orientation concentration required before we claim a
 * building has facades. |R| is the resultant length of the length-weighted mean
 * of exp(i*4*theta) over the footprint edges: 1.0 for a perfect rectangle, ~0
 * for a circle. Below this we fall back to true compass views and say so in the
 * UI rather than inventing a facade the footprint doesn't support.
 */
export const FACADE_CONCENTRATION_MIN = 0.5;

const EARTH_RADIUS_M = 6_378_137; // WGS84 equatorial radius.

export interface FloorElevation {
  /** Eye elevation in the source datum (NAVD88 orthometric), meters. */
  eyeElevationNavd88M: number;
  /** Eye elevation as a WGS84 ellipsoidal height, meters (renderer input). */
  eyeElevationEllipsoidalM: number;
  /** GEOID18 undulation applied (meters, negative over NYC). */
  geoidHeightM: number;
  /** True when the requested floor exceeded the roof and was clamped. */
  clampedToRoof: boolean;
}

/**
 * Estimate eye elevation for a floor, in both datums.
 *
 * floor 1 sits at ground; each floor above adds ASSUMED_FLOOR_HEIGHT_M. The eye
 * is EYE_ABOVE_FLOOR_M above the slab. The result is clamped so it can never
 * exceed the real roof height — we refuse to place a camera above a building
 * that isn't that tall, which would fabricate a vantage that doesn't exist.
 *
 * The NAVD88 -> WGS84 conversion is not cosmetic: it is worth about -31.7 m in
 * NYC, i.e. ten floors. See lib/geoid.ts.
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

  const eyeElevationNavd88M = footprint.groundElevationNavd88M + cappedAboveGround;
  const undulation = geoidHeightM(
    footprint.centroid.lat,
    footprint.centroid.lng,
  );

  return {
    eyeElevationNavd88M,
    eyeElevationEllipsoidalM: eyeElevationNavd88M + undulation,
    geoidHeightM: undulation,
    clampedToRoof,
  };
}

/** Degrees → radians. */
function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Radians → degrees. */
function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Normalize a bearing into [0, 360). */
export function normalizeBearing(deg: number): number {
  return ((deg % 360) + 360) % 360;
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
 * Project a GeoJSON [lng, lat] ring into local metric coordinates
 * (x = meters east, y = meters north) relative to an origin. Equirectangular;
 * sub-millimetre over a building footprint.
 */
export function ringToLocalMeters(
  ring: Array<[number, number]>,
  origin: { lat: number; lng: number },
): Array<[number, number]> {
  const cosLat = Math.cos(toRad(origin.lat));
  return ring.map(([lng, lat]): [number, number] => [
    (lng - origin.lng) * toRad(1) * EARTH_RADIUS_M * cosLat,
    (lat - origin.lat) * toRad(1) * EARTH_RADIUS_M,
  ]);
}

/** Even-odd point-in-polygon test in local metric coordinates. */
export function pointInRingMeters(
  pts: Array<[number, number]>,
  x: number,
  y: number,
): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    const intersects =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Distance in meters from the building centroid to the **outermost** footprint
 * boundary crossing along a compass heading.
 *
 * Taking the farthest crossing rather than the nearest is what makes this
 * correct for concave / L-shaped / courtyard footprints (the Dakota is a real
 * NYC example): the nearest crossing can be the wall of an inner notch, and
 * pushing 6 m past *that* leaves the camera still inside the building mass.
 * Past the farthest crossing, the ray has left the polygon for good.
 *
 * Returns 0 for degenerate rings (< 3 points) or if the ray misses every edge,
 * so the caller's FACADE_OFFSET_M still applies as a minimum push.
 */
export function facadeDistanceM(
  ring: Array<[number, number]>,
  centroid: { lat: number; lng: number },
  headingDeg: number,
): number {
  if (ring.length < 3) return 0;

  const bearing = toRad(headingDeg);
  const dirX = Math.sin(bearing); // east component of heading unit vector
  const dirY = Math.cos(bearing); // north component of heading unit vector

  const pts = ringToLocalMeters(ring, centroid);

  let maxT = -Infinity;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % n];
    // Solve: origin + t*dir = A + s*(B - A)
    const ex = bx - ax;
    const ey = by - ay;
    const denom = dirX * ey - dirY * ex;
    if (Math.abs(denom) < 1e-9) continue; // ray parallel to edge
    const t = (ax * ey - ay * ex) / denom;
    const s = (ax * dirY - ay * dirX) / denom;
    // t > 0: intersection is ahead of the centroid along the heading.
    // 0 <= s <= 1: intersection is on the segment, not its extension.
    if (t > 1e-3 && s >= -1e-6 && s <= 1 + 1e-6 && t > maxT) maxT = t;
  }

  return Number.isFinite(maxT) && maxT > 0 ? maxT : 0;
}

/**
 * Distance from `origin` to the FIRST crossing of `ring` along a unit direction,
 * all in local metres. `null` when the ray never meets the ring.
 *
 * The mirror image of `facadeDistanceM`, which takes the outermost crossing
 * because it is escaping a polygon. This one is entering one, so the nearest
 * crossing is the answer: it measures how much open ground lies ahead before
 * the neighbouring building starts. That is the width of a light court or side
 * lot when the ring belongs to the building across it.
 */
export function rayFirstCrossingM(
  pts: Array<[number, number]>,
  origin: [number, number],
  dirX: number,
  dirY: number,
): number | null {
  let best = Infinity;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = [pts[i][0] - origin[0], pts[i][1] - origin[1]];
    const [bx, by] = [pts[(i + 1) % n][0] - origin[0], pts[(i + 1) % n][1] - origin[1]];
    const ex = bx - ax;
    const ey = by - ay;
    const denom = dirX * ey - dirY * ex;
    if (Math.abs(denom) < 1e-9) continue; // ray parallel to edge
    const t = (ax * ey - ay * ex) / denom;
    const s = (ax * dirY - ay * dirX) / denom;
    if (t > 1e-3 && s >= -1e-6 && s <= 1 + 1e-6 && t < best) best = t;
  }
  return Number.isFinite(best) ? best : null;
}

export interface FacadeAxis {
  /** Bearing of the first facade normal, normalized into [0, 90). */
  bearingDeg: number;
  /**
   * Length-weighted orientation concentration in [0, 1]. 1 = every edge is
   * axis-aligned with the same rectilinear frame; ~0 = no dominant orientation.
   */
  concentration: number;
}

/**
 * Find the building's dominant rectilinear orientation from its footprint edges.
 *
 * Method: each edge contributes exp(i * 4 * theta), weighted by its length,
 * where theta is the edge bearing. Multiplying the angle by 4 makes the estimate
 * invariant under 90-degree rotation, which is exactly the symmetry of a
 * rectangular building — a wall and its perpendicular neighbour vote for the
 * same axis instead of cancelling. The resultant's argument divided by 4 is the
 * dominant axis; the resultant's normalized length is how strongly the footprint
 * actually commits to it.
 *
 * Manhattan sanity check: the borough's street grid is rotated about 29 degrees
 * clockwise from true north, so most Manhattan footprints return ~29 (or an
 * equivalent 90-degree rotation of it), not 0.
 */
export function principalFacadeAxis(
  ring: Array<[number, number]>,
  centroid: { lat: number; lng: number },
): FacadeAxis {
  const pts = ringToLocalMeters(ring, centroid);
  if (pts.length < 3) return { bearingDeg: 0, concentration: 0 };

  let sumX = 0;
  let sumY = 0;
  let totalLen = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    // Compass bearing of the edge: atan2(east, north).
    const theta = Math.atan2(dx, dy);
    sumX += len * Math.cos(4 * theta);
    sumY += len * Math.sin(4 * theta);
    totalLen += len;
  }
  if (totalLen === 0) return { bearingDeg: 0, concentration: 0 };

  const concentration = Math.hypot(sumX, sumY) / totalLen;
  const bearing = normalizeBearing(toDeg(Math.atan2(sumY, sumX)) / 4) % 90;
  return { bearingDeg: bearing, concentration };
}

/**
 * The four view bearings for a footprint, plus how they were chosen.
 *
 * `facade` basis: the outward normals of the building's dominant wall planes —
 * i.e. the direction a window in each wall actually faces.
 * `compass` basis: true N/E/S/W, used only when the footprint has no dominant
 * orientation. The basis is carried through to the UI so the labelling is never
 * ambiguous about which one you're looking at.
 */
export function viewBearings(footprint: BuildingFootprint): {
  basis: ViewBasis;
  bearingsDeg: number[];
  axis: FacadeAxis;
} {
  const axis = principalFacadeAxis(footprint.ring, footprint.centroid);
  if (axis.concentration >= FACADE_CONCENTRATION_MIN) {
    return {
      basis: "facade",
      bearingsDeg: [0, 1, 2, 3].map((k) =>
        normalizeBearing(axis.bearingDeg + 90 * k),
      ),
      axis,
    };
  }
  return { basis: "compass", bearingsDeg: [0, 90, 180, 270], axis };
}

/**
 * Build the four camera views for a footprint at a given ellipsoidal eye height.
 *
 * Each camera is placed just outside the building wall in its bearing — first we
 * ray-cast from the centroid to the outermost footprint crossing, then push
 * FACADE_OFFSET_M beyond it, then *verify* the resulting point is outside the
 * footprint polygon and push further if it isn't. The verification matters for
 * footprints whose centroid lies outside the polygon (U- and L-shaped
 * buildings), where no single offset rule is safe by construction.
 *
 * A slight downward tilt (pitchDeg < 0) is applied so city geometry fills the
 * frame rather than open sky. The tilt increases gently with floor height: at
 * street-level floors you want a near-horizontal view; at the 80th floor of the
 * Empire State Building a -9 degree tilt puts the Midtown skyline in frame.
 */
export function buildCameraViews(
  footprint: BuildingFootprint,
  eyeElevationEllipsoidalM: number,
  eyeAboveGroundM: number,
  /**
   * Override for `FACADE_OFFSET_M`. Exists so the offset can be swept in a
   * controlled bake-off against real imagery without editing a constant between
   * runs; production callers pass nothing and get the selected default.
   */
  facadeOffsetM: number = FACADE_OFFSET_M,
  /**
   * Per-direction replacements for `facadeOffsetM`, keyed by slot.
   *
   * Used for exactly one thing: a facade across a light court narrower than the
   * default offset, where 6 m would put the camera inside the building
   * opposite. The court is measured from neighbouring footprints AFTER the
   * first pass of this function, so `pipeline/planView.ts` calls it a second
   * time with the reduced offsets rather than this module guessing at data it
   * does not have. See `confidence.courtStandoffM`.
   */
  offsetBySlot: Partial<Record<ViewSlot, number>> = {},
): { views: CameraView[]; basis: ViewBasis; concentration: number } {
  // -3 deg at ground level -> -9 deg at 200 m+, clamped; keeps sky in the top third.
  const pitchDeg = Math.max(-9, -(3 + eyeAboveGroundM / 33));
  const { basis, bearingsDeg, axis } = viewBearings(footprint);
  const localRing = ringToLocalMeters(footprint.ring, footprint.centroid);

  const views = bearingsDeg.map((headingDeg, i) => {
    const wallDist = facadeDistanceM(
      footprint.ring,
      footprint.centroid,
      headingDeg,
    );
    const offsetM = offsetBySlot[VIEW_SLOTS[i]] ?? facadeOffsetM;
    let standoffM = wallDist + offsetM;

    // Verify the camera is genuinely outside the footprint; push out in
    // RESCUE_STEP_M steps if a pathological ring puts it back inside.
    //
    // For any simple ring this loop provably never runs: `facadeDistanceM`
    // returns the OUTERMOST boundary crossing, past which the ray has left the
    // polygon for good, so `wallDist + anything positive` is already outside —
    // even for a C whose centroid sits in the notch (pinned in
    // geometry.test.ts). It stays as a guard against self-intersecting or
    // otherwise malformed source rings, where even-odd parity can disagree with
    // the raycast. The step is deliberately independent of `facadeOffsetM`: a
    // sub-metre offset should not turn the escape hatch into a crawl.
    const dirX = Math.sin(toRad(headingDeg));
    const dirY = Math.cos(toRad(headingDeg));
    for (let guard = 0; guard < 8; guard++) {
      if (
        !pointInRingMeters(localRing, standoffM * dirX, standoffM * dirY)
      ) {
        break;
      }
      standoffM += RESCUE_STEP_M;
    }

    const { lat, lng } = offsetLatLng(
      footprint.centroid.lat,
      footprint.centroid.lng,
      headingDeg,
      standoffM,
    );
    return {
      slot: VIEW_SLOTS[i],
      headingDeg,
      compass: compassLabel(headingDeg),
      lat,
      lng,
      heightM: eyeElevationEllipsoidalM,
      pitchDeg,
      standoffM,
      wallDistanceM: wallDist,
    } satisfies CameraView;
  });

  return { views, basis, concentration: axis.concentration };
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

  // Shift to a local origin before the shoelace, and shift back at the end.
  //
  // Run on raw WGS84 degrees this loses the answer to cancellation. Near
  // (-73.95, 40.77) each `x0*y1 - x1*y0` is about -3.0e3 while their signed sum
  // — the polygon area — is about 1e-7 deg^2, so roughly eleven significant
  // digits cancel and doubles have about sixteen. Measured against a
  // stable computation on the real footprint for BIN 1050349, the centroid came
  // out 10.4 m off, which moved that building's camera 10.3 m sideways along its
  // own facade on two of four headings. Error grew with vertex count: 0.37 m at
  // the Dakota (17 points), 3.55 m at the Flatiron (49), 10.37 m here (29).
  //
  // Translation is exact enough to remove the problem because it makes the
  // terms the same order as the result; the centroid of a translated polygon is
  // the translated centroid, so nothing else changes.
  const ox = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const oy = pts.reduce((a, p) => a + p[1], 0) / pts.length;

  let areaSum = 0;
  let cxSum = 0;
  let cySum = 0;
  for (let i = 0; i < pts.length; i++) {
    const x0 = pts[i][0] - ox;
    const y0 = pts[i][1] - oy;
    const j = (i + 1) % pts.length;
    const x1 = pts[j][0] - ox;
    const y1 = pts[j][1] - oy;
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
  return { lng: cxSum / (6 * area) + ox, lat: cySum / (6 * area) + oy };
}
