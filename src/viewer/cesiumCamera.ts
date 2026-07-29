// Cesium camera placement for a CameraView.
//
// Kept separate from the React component so the mapping from our real-data
// CameraView (lat/lng/height/heading) to Cesium's camera API is a small, single-
// responsibility function. The heading/pitch/roll conversion to radians is the
// one bit of Cesium-specific math and is unit-tested.

import {
  Cartesian3,
  Math as CesiumMath,
  type Camera,
} from "cesium";
import type { CameraView } from "../lib/types";

/** Cesium orientation (radians) derived from a CameraView (degrees). */
export interface CesiumOrientation {
  heading: number;
  pitch: number;
  roll: number;
}

/**
 * Convert a CameraView's degree headings/pitch into Cesium's radian
 * orientation. Pure and testable — no Cesium runtime needed beyond the constant.
 */
export function toCesiumOrientation(view: CameraView): CesiumOrientation {
  return {
    heading: CesiumMath.toRadians(view.headingDeg),
    // Cesium pitch: 0 = horizon, negative = look down. Our pitchDeg uses the
    // same convention (0 = horizon), so pass through as radians.
    pitch: CesiumMath.toRadians(view.pitchDeg),
    roll: 0,
  };
}

/**
 * Position + orient a Cesium camera for a CameraView. Uses setView with a
 * destination at the real lat/lng/height so the camera sits exactly at the
 * computed vantage inside the 3D-tile mesh.
 */
export function applyCameraView(camera: Camera, view: CameraView): void {
  const orientation = toCesiumOrientation(view);
  camera.setView({
    destination: Cartesian3.fromDegrees(view.lng, view.lat, view.heightM),
    orientation,
  });
}
