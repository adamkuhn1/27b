// A small top-down diagram of where the four cameras stand and which way
// each one looks, with north fixed at the top. It exists to make the
// facade-aligned bearings visible at a glance: on the Manhattan grid the
// arrows sit visibly skewed (~29°) from the true-north marker.
//
// Only real plan data is drawn: camera lat/lng relative to the footprint
// centroid, and each camera's true heading. The footprint polygon stays on
// the backend, so no building outline is drawn rather than an invented one.

import { useId } from "react";
import type { CameraView, ViewBasis, ViewSlot } from "../lib/types";

/** Meters per degree of latitude on a sphere of the mean Earth radius. */
const M_PER_DEG = (Math.PI / 180) * 6_371_008.8;

/** Layout of the square diagram, in viewBox units. */
export const MAP_SIZE = 200;
const CAMERA_RING = 32; // farthest camera's distance from the centre
const ARROW_LEN = 22;
const LABEL_GAP = 9;

export interface MapArrow {
  slot: ViewSlot;
  compass: string;
  headingDeg: number;
  /** Camera position. */
  x: number;
  y: number;
  /** Arrow end, along the heading. */
  tipX: number;
  tipY: number;
  /** Label anchor point beyond the tip. */
  labelX: number;
  labelY: number;
  /** SVG text-anchor that keeps the label clear of the arrow. */
  anchor: "start" | "middle" | "end";
}

/**
 * Project the plan's cameras into the diagram's viewBox (north up, east
 * right). Camera lat/lng become meters east/north of the centroid (a local
 * equirectangular projection, exact enough at building scale), then are
 * scaled so the farthest camera sits on a fixed ring around the centre.
 * Arrows run outward along each camera's true heading.
 */
export function projectViews(
  views: readonly CameraView[],
  centroid: { lat: number; lng: number },
): MapArrow[] {
  const c = MAP_SIZE / 2;
  const cosLat = Math.cos((centroid.lat * Math.PI) / 180);
  const offsets = views.map((v) => ({
    east: (v.lng - centroid.lng) * M_PER_DEG * cosLat,
    north: (v.lat - centroid.lat) * M_PER_DEG,
  }));
  const maxR = Math.max(0, ...offsets.map((o) => Math.hypot(o.east, o.north)));

  return views.map((v, i) => {
    const h = (v.headingDeg * Math.PI) / 180;
    const dx = Math.sin(h); // east
    const dy = -Math.cos(h); // SVG y grows downward, so north is -y
    // A degenerate plan (every camera on the centroid) still gets a readable
    // diagram: place the camera on the ring along its own heading.
    const x = maxR > 1e-6 ? c + (offsets[i].east / maxR) * CAMERA_RING : c + dx * CAMERA_RING;
    const y = maxR > 1e-6 ? c - (offsets[i].north / maxR) * CAMERA_RING : c + dy * CAMERA_RING;
    const tipX = x + dx * ARROW_LEN;
    const tipY = y + dy * ARROW_LEN;
    return {
      slot: v.slot,
      compass: v.compass,
      headingDeg: v.headingDeg,
      x,
      y,
      tipX,
      tipY,
      labelX: tipX + dx * LABEL_GAP,
      // Nudge down by ~a third of the font size so the label centres on the
      // ray (dominant-baseline is unreliable across browsers).
      labelY: tipY + dy * LABEL_GAP + 4.5,
      anchor: dx > 0.35 ? "start" : dx < -0.35 ? "end" : "middle",
    };
  });
}

/**
 * How far the views sit off the true compass grid, as a signed angle in
 * (-45°, 45°]: 0 for N/E/S/W views, ~29 on Manhattan's grid. Taken from the
 * first view; the four views of a plan are 90° apart.
 */
export function gridOffsetDeg(views: readonly CameraView[]): number | null {
  if (views.length === 0) return null;
  const m = ((views[0].headingDeg % 90) + 90) % 90;
  return m > 45 ? m - 90 : m;
}

export function orientationCaption(basis: ViewBasis, views: readonly CameraView[]): string {
  if (basis === "compass") return "Views face true N, E, S and W";
  const off = Math.round(gridOffsetDeg(views) ?? 0);
  if (off === 0) return "Views follow the walls, square to north";
  return `Views follow the walls, ${Math.abs(off)}° ${off > 0 ? "east" : "west"} of north`;
}

export function OrientationMap({
  views,
  centroid,
  basis,
}: {
  views: readonly CameraView[];
  centroid: { lat: number; lng: number };
  basis: ViewBasis;
}) {
  const markerId = `arrowhead-${useId().replace(/:/g, "")}`;
  const arrows = projectViews(views, centroid);
  const c = MAP_SIZE / 2;
  const caption = orientationCaption(basis, views);
  const description =
    "Top-down map of the four views, north up: " +
    arrows.map((a) => `${a.compass} ${Math.round(a.headingDeg)}°`).join(", ") +
    ".";

  return (
    <figure className="orientation-map">
      <svg viewBox={`0 0 ${MAP_SIZE} ${MAP_SIZE}`} role="img" aria-label={description}>
        <defs>
          {(["view", "north"] as const).map((kind) => (
            <marker
              key={kind}
              id={`${markerId}-${kind}`}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              {/* Markers don't inherit the referencing line's colour, so
                  each kind gets its own head. */}
              <path d="M0,0 L10,5 L0,10 z" className={`om-head-${kind}`} />
            </marker>
          ))}
        </defs>

        {/* True north, fixed: the reference the arrows are read against. */}
        <g className="om-north">
          <line x1={18} y1={46} x2={18} y2={23} markerEnd={`url(#${markerId}-north)`} />
          <text x={18} y={17} textAnchor="middle">
            N
          </text>
        </g>

        {arrows.map((a) => (
          <line key={`r-${a.slot}`} className="om-standoff" x1={c} y1={c} x2={a.x} y2={a.y} />
        ))}
        <circle className="om-building" cx={c} cy={c} r={4} />

        {arrows.map((a) => (
          <g key={a.slot} className="om-view">
            <circle cx={a.x} cy={a.y} r={3} />
            <line x1={a.x} y1={a.y} x2={a.tipX} y2={a.tipY} markerEnd={`url(#${markerId}-view)`} />
            <text x={a.labelX} y={a.labelY} textAnchor={a.anchor}>
              {a.compass}
            </text>
          </g>
        ))}
      </svg>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
