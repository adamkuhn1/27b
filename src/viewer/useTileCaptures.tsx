import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { googleMapsKey } from "../lib/config";
import { isRenderableDirection } from "../lib/confidence";
import { metrics } from "../lib/metrics";
import { describeError } from "../lib/redact";
import type {
  CaptureEvent,
  RenderSession,
  SlotPhase,
  ViewPlan,
  ViewSlot,
} from "../lib/types";

// The four captures are produced ONCE per plan (a single Cesium session, four
// static frames) and shared across the four CesiumView frames via context. That
// is what keeps the app to ONE root-tileset request per address instead of four
// live globes — and the root-tileset request is the billable unit for
// Photorealistic 3D Tiles (the renderer's own tile requests inside the session
// are unmetered):
// https://developers.google.com/maps/documentation/tile/usage-and-billing
//
// The frames are NOT persisted. Google Maps Platform ToS §3.2.3(b) forbids
// caching Google Maps Content except where the Maps Service Specific Terms
// allow it, and those terms contain no Map Tiles allowance. So captures live in
// this component's state for as long as the result is on screen, and no longer.
//
// WHAT CHANGED, AND WHY IT MATTERED
//
// This provider used to `await renderFourViews(...)` once and call `setCaptures`
// once. Every frame was complete in hand inside that call — the first at roughly
// 10-16 s — and none of them reached the screen until the fourth finished, at
// 37-62 s. Now it consumes the session's event stream and commits each frame as
// it arrives, so a direction appears the moment it exists.
//
// There are no fake stages and no percentage. What is displayed is what the app
// actually knows: which direction is being captured right now (the loop index),
// how many of four have landed (a count of completed work), and nothing else.
// A progress *bar* is not available honestly — the capture ends on either a
// quiet period or a hard timeout, and neither is a fraction of a known total.

/** Per-direction state, including the frame once there is one. */
export interface SlotState {
  phase: SlotPhase;
  /** Present only when `phase === "ready"`. Real capture, or nothing. */
  dataUrl?: string;
  /** Whether OUR CAPTURE finished refining. Not a claim about the picture. */
  settled?: boolean;
  /** How many attempts this direction has had in this session. */
  attempts: number;
}

/** Whole-result state. */
export type SessionPhase =
  /** No key, or rendering suppressed. */
  | "idle"
  /** A session is open and directions are still arriving. */
  | "running"
  /** The session finished. Some, all or none of the directions may have landed. */
  | "settled"
  /** No session could be established at all. Nothing rendered, nothing faked. */
  | "failed";

export interface TileCaptures {
  phase: SessionPhase;
  bySlot: Partial<Record<ViewSlot, SlotState>>;
  /** Aggregated Google data attribution for the frames on screen. */
  attribution?: string;
  /** True while the WebGL session is alive, so a free per-direction retry exists. */
  sessionOpen: boolean;
  /** Request one direction again inside the open session. Zero billable cost. */
  retrySlot: (slot: ViewSlot) => void;
}

const IDLE: TileCaptures = {
  phase: "idle",
  bySlot: {},
  sessionOpen: false,
  retrySlot: () => {},
};

const CapturesContext = createContext<TileCaptures>(IDLE);

/** Count of directions that have produced a real frame. */
export function readyCount(bySlot: TileCaptures["bySlot"]): number {
  return Object.values(bySlot).filter((s) => s?.phase === "ready").length;
}

/**
 * Provider that opens a render session for a plan and reveals each direction as
 * it lands.
 *
 * `disabled` short-circuits everything: with no imagery key, this never imports
 * or invokes the tile renderer, so the metered path is unreachable without a key.
 */
export function TileCapturesProvider({
  plan,
  disabled,
  children,
}: {
  plan: ViewPlan;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [phase, setPhase] = useState<SessionPhase>(disabled ? "idle" : "running");
  const [bySlot, setBySlot] = useState<TileCaptures["bySlot"]>({});
  const [attribution, setAttribution] = useState<string | undefined>();
  const [sessionOpen, setSessionOpen] = useState(false);

  // Guard against double-run (React 18 StrictMode) and stale plan updates.
  const runIdRef = useRef(0);
  const sessionRef = useRef<RenderSession | null>(null);
  const creditsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    creditsRef.current = new Set();
    setBySlot({});
    setAttribution(undefined);
    setSessionOpen(false);

    if (disabled) {
      setPhase("idle");
      return;
    }

    const key = googleMapsKey();
    if (!key) {
      // Belt-and-suspenders: no key => never touch the renderer.
      setPhase("idle");
      return;
    }

    const runId = ++runIdRef.current;
    setPhase("running");

    // A facade on a shared lot line has no window, and a camera six metres
    // beyond it is inside the building next door rather than outdoors. Those
    // directions are not captured at all: the provider would return the
    // interior of a neighbouring mesh, which looks exactly like the "melted
    // grey landscape" this project must never present as a view. The pane says
    // so instead. See DirectionConfidence.insideNeighborByM.
    const renderable = plan.views.filter((v) =>
      isRenderableDirection(v.slot, plan.confidence),
    );

    // Every direction is known and correctly labelled from the instant the plan
    // resolves — the bearings come from the geometry pipeline, not the imagery.
    // So the grid is real, specific content immediately; frames land into it.
    setBySlot(
      Object.fromEntries(
        renderable.map((v) => [v.slot, { phase: "queued", attempts: 0 }]),
      ),
    );

    if (renderable.length === 0) {
      // Nothing to ask the provider for. Not a failure — a building whose every
      // facade abuts another. Zero billable requests.
      setPhase("settled");
      return;
    }

    // Ties the Cesium session's lifetime to this effect. Without this, React
    // 18 StrictMode's double-invoke (or a plan change) leaves the first run's
    // viewer alive in the background — a second real WebGL context — and the
    // two fight over the GPU instead of the first one being torn down.
    const controller = new AbortController();
    const current = () => runId === runIdRef.current;

    (async () => {
      let session: RenderSession;
      try {
        // Lazily import the heavy Cesium renderer only on the real render path.
        const { openRenderSession } = await import("./tileRenderer");
        session = await openRenderSession(renderable, {
          apiKey: key,
          signal: controller.signal,
        });
      } catch (err) {
        if (!current() || controller.signal.aborted) return; // superseded
        reportSessionFailure(err);
        // Honest failure: empty frames, never a fabricated scene.
        setPhase("failed");
        setBySlot(concludeUnfinished);
        return;
      }

      if (!current()) {
        session.close();
        return;
      }
      sessionRef.current = session;
      setSessionOpen(true);
      metrics.recordSessionOpened();

      for await (const event of session.events) {
        if (!current()) break;
        applyEvent(event);
      }
      if (current()) {
        setSessionOpen(false);
        setPhase("settled");
        setBySlot(concludeUnfinished);
      }
    })();

    function applyEvent(event: CaptureEvent) {
      switch (event.kind) {
        case "session-open":
          return;
        case "view-started":
          setBySlot((prev) => ({
            ...prev,
            [event.slot]: {
              ...(prev[event.slot] ?? { attempts: 0 }),
              phase: "capturing",
              attempts: event.attempt,
            },
          }));
          return;
        case "view-captured": {
          const { result } = event;
          metrics.recordCaptureLatency(event.elapsedMs);
          // The Map Tiles policy asks for all attributions for displayed tiles,
          // aggregated and sorted, in a line. Recomputed per arrival now rather
          // than once at the end, so the credit line is correct for whatever is
          // actually on screen at any moment.
          for (const credit of result.attribution) {
            if (credit) creditsRef.current.add(credit);
          }
          setAttribution(Array.from(creditsRef.current).sort().join(", "));
          setBySlot((prev) => ({
            ...prev,
            [result.slot]: {
              phase: "ready",
              dataUrl: result.dataUrl,
              settled: event.settled,
              attempts: event.attempt,
            },
          }));
          return;
        }
        case "view-failed":
          // The specific cause is an operator diagnostic, not visitor copy — it
          // goes to the console, never onto the screen.
          console.error(
            `[27b] direction ${event.slot} failed (attempt ${event.attempt}):`,
            event.failure.detail,
          );
          setBySlot((prev) => ({
            ...prev,
            [event.slot]: {
              // A direction that is going to be retried is still in flight, not
              // finished. Showing it as failed and then un-failing it would be
              // a state the app invented.
              phase: event.willRetry ? "queued" : "failed",
              attempts: event.attempt,
            },
          }));
          return;
        case "session-closed":
          sessionRef.current = null;
          setSessionOpen(false);
          return;
      }
    }

    return () => {
      controller.abort();
      sessionRef.current?.close();
      sessionRef.current = null;
    };
  }, [plan, disabled]);

  const retrySlot = useCallback((slot: ViewSlot) => {
    const session = sessionRef.current;
    if (!session || !session.isOpen) return;
    void session.recapture(slot);
  }, []);

  const value = useMemo<TileCaptures>(
    () => ({ phase, bySlot, attribution, sessionOpen, retrySlot }),
    [phase, bySlot, attribution, sessionOpen, retrySlot],
  );

  return (
    <CapturesContext.Provider value={value}>{children}</CapturesContext.Provider>
  );
}

/**
 * Close out every direction that never reached a terminal event.
 *
 * A session can end with directions still `queued` — it was aborted, or one
 * failure was fatal for the whole session, or it never opened at all. Left
 * alone those slots keep their starting phase for as long as the result is on
 * screen, which means an empty frame that announces "waiting to capture the
 * view facing WNW" about a capture that can no longer happen, a hairline axis
 * on the plan that never resolves, and a whole-result note that counts them as
 * still arriving. The session is over; the honest phase is that they did not
 * load.
 *
 * Returns the same object when there is nothing to change, so React does not
 * re-render on every settled session.
 */
function concludeUnfinished(
  prev: TileCaptures["bySlot"],
): TileCaptures["bySlot"] {
  let changed = false;
  const next: TileCaptures["bySlot"] = { ...prev };
  for (const [slot, state] of Object.entries(prev) as Array<
    [ViewSlot, SlotState | undefined]
  >) {
    if (state && (state.phase === "queued" || state.phase === "capturing")) {
      next[slot] = { ...state, phase: "failed" };
      changed = true;
    }
  }
  return changed ? next : prev;
}

/**
 * Diagnose a session that never opened. Console only — the on-screen message
 * stays generic and honest: nothing rendered, and nothing was faked either.
 * The README's troubleshooting note covers the 403 case for an operator.
 */
function reportSessionFailure(err: unknown): void {
  const detail = describeError(err);
  const status = (err as { statusCode?: unknown }).statusCode;
  const is403 = status === 403 || /403|Forbidden/i.test(detail);
  console.error(
    is403
      ? "[27b] Map Tiles API returned 403 — check the key is enabled for the Map Tiles API and has no HTTP-referrer restriction blocking this origin."
      : "[27b] render session could not be opened:",
    detail,
  );
}

/** Read the shared capture state for the current view frame. */
export function useTileCaptures(disabled?: boolean): TileCaptures {
  const ctx = useContext(CapturesContext);
  if (disabled) return IDLE;
  return ctx;
}
