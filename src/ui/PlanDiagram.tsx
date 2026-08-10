import type { ViewPlan, ViewSlot } from "../lib/types";
import { ringToLocalMeters } from "../lib/geometry";
import type { RenderState } from "../lib/types";

// A plan drawing: this building's real footprint, and where the four cameras
// stand relative to it.
//
// It is drawn from `plan.footprint.ring` and `view.standoffM` — NYC Open Data
// and our own arithmetic, nothing else. No provider content is involved, so it
// raises no licence question, and it is on screen within about a second of the
// address resolving, long before any imagery exists.
//
// It doubles as the progress display, which is the point: an arrow is hairline
// while its direction is queued and solid once its frame has landed, so every
// mark corresponds to a real completed unit of work. There is no bar, because
// there is no denominator — the capture ends on either a quiet period or a hard
// timeout, and neither is a fraction of a known total.
//
// It also answers the question the four panes cannot: *why is this direction
// 29°?* Because that is the way this footprint's walls face.

const SIZE = 260;
/**
 * Margin the drawing leaves for its own labels, in the same user units as
 * everything else here.
 *
 * The compass labels sit at 1.12x the furthest camera plus a 9-unit offset, and
 * they are centred, so half a label's width has to fit as well. At the label
 * size the stylesheet sets (14.3 units, which renders at 11 px in the 200 px
 * column) that is `(SIZE / 2 - PADDING) * 1.12 + 9 + 13 <= SIZE / 2`. 38 is the
 * smallest round number that satisfies it, so the plan stays as large as it can
 * while every label lands inside the box.
 */
const PADDING = 38;

interface PlanDiagramProps {
  plan: ViewPlan;
  stateBySlot: Partial<Record<ViewSlot, RenderState>>;
}

export function PlanDiagram({ plan, stateBySlot }: PlanDiagramProps) {
  const ring = ringToLocalMeters(plan.footprint.ring, plan.footprint.centroid);
  if (ring.length < 3) return null;

  // Everything is measured from the centroid in metres; fit the whole drawing
  // — footprint plus the furthest camera — into the box with a single scale, so
  // the standoffs are to scale against the building rather than decorative.
  const reach = Math.max(
    ...ring.map(([x, y]) => Math.hypot(x, y)),
    ...plan.views.map((v) => v.standoffM),
  );
  const scale = (SIZE / 2 - PADDING) / reach;

  const toSvg = (x: number, y: number): [number, number] => [
    SIZE / 2 + x * scale,
    // Screen y grows downward; north is up.
    SIZE / 2 - y * scale,
  ];

  const ringPath = ring
    .map(([x, y], i) => {
      const [px, py] = toSvg(x, y);
      return `${i === 0 ? "M" : "L"}${px.toFixed(1)} ${py.toFixed(1)}`;
    })
    .join(" ");

  return (
    <figure className="plan">
      <svg
        className="plan__svg"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={`Plan of this building's footprint with the four camera positions, facing ${plan.views
          .map((v) => `${v.compass} ${Math.round(v.headingDeg)} degrees`)
          .join(", ")}`}
      >
        <path className="plan__ring" d={`${ringPath} Z`} />
        {plan.views.map((view) => {
          const rad = (view.headingDeg * Math.PI) / 180;
          const dx = Math.sin(rad);
          const dy = Math.cos(rad);
          const [x0, y0] = toSvg(0, 0);
          const [x1, y1] = toSvg(dx * view.standoffM, dy * view.standoffM);
          // A short stub past the camera showing which way it looks.
          const [x2, y2] = toSvg(
            dx * (view.standoffM + reach * 0.12),
            dy * (view.standoffM + reach * 0.12),
          );
          const state = stateBySlot[view.slot] ?? "queued";
          return (
            <g key={view.slot} className={`plan__axis plan__axis--${state}`}>
              <line x1={x0} y1={y0} x2={x1} y2={y1} className="plan__stem" />
              <line x1={x1} y1={y1} x2={x2} y2={y2} className="plan__look" />
              <circle cx={x1} cy={y1} r={3} className="plan__eye" />
              <text
                x={x2 + dx * 9}
                y={y2 - dy * 9}
                className="plan__label"
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {view.compass}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="plan__caption">
        Footprint and camera standoffs, to scale · north up
      </figcaption>
    </figure>
  );
}
