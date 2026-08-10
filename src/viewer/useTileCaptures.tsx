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
import { isDirectionRequested } from "../lib/directionClass";
import { metrics } from "../lib/metrics";
import { describeError } from "../lib/redact";
import { captureOrder } from "../ui/leadDirection";
import type {
  CaptureEvent,
  RenderState,
  RenderSession,
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
// actually knows: the state of each direction in words inside its own frame
// (waiting, capturing, didn't load, or the geometry reason nothing was asked
// for), and a count of how many of the requested directions have landed. A
// progress *bar* is not available honestly — a capture ends on either a quiet
// period or a hard deadline, and neither is a fraction of a known total.
//
// Two rules hold over the whole event stream, and both are enforced in
// `applyCaptureEvent` rather than left to the caller:
//
//   1. Every one of the four directions has a state from the moment the plan
//      resolves, including the ones nothing will ever be requested for.
//   2. Once a direction holds a real capture, no later event removes it.

/** Per-direction state, including the frame once there is one. */
export interface SlotState {
  phase: RenderState;
  /** Present only when `phase === "ready"`. Real capture, or nothing. */
  dataUrl?: string;
  /** Whether OUR CAPTURE finished refining. Not a claim about the picture. */
  settled?: boolean;
  /**
   * A further attempt is running for a direction that already has a frame. The
   * frame stays on screen while it runs; this only says another one is being
   * taken.
   */
  recapturing?: boolean;
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
 * Count of directions the provider was asked for.
 *
 * The denominator for every "n of m" the app says. Not four: a building with a
 * party wall has fewer sides to photograph, and counting a wall that was never
 * requested reports a failure where nothing failed.
 */
export function requestedCount(bySlot: TileCaptures["bySlot"]): number {
  return Object.values(bySlot).filter(
    (s) => s && s.phase !== "not-requested",
  ).length;
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
    setAttribution(undefined);
    setSessionOpen(false);

    // ALL FOUR directions get a state, before anything else happens and whether
    // or not a render will follow. A direction absent from this map has no
    // state at all, and every reader of it then has to invent one; that is how
    // a court too narrow to stand in came to be drawn on the plan drawing with
    // the party-wall stroke. `not-requested` is a state, and the reason it
    // holds is the direction's geometry class, which lives in one place.
    setBySlot(
      Object.fromEntries(
        plan.views.map((v) => [
          v.slot,
          {
            phase: isDirectionRequested(v.slot, plan.confidence)
              ? "queued"
              : "not-requested",
            attempts: 0,
          },
        ]),
      ),
    );

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
    // so instead. Which directions those are is decided by the geometry class
    // (lib/directionClass.ts) and by nothing here.
    //
    // ORDER. Captured in the geometry's own preference order, so the direction
    // the result opens on is the first one asked for rather than whichever slot
    // happens to sort first. Both orders are decided by the same deterministic
    // ranking over the same footprint arithmetic, before any imagery exists —
    // no camera parameter moves, and nothing is reordered once frames start
    // arriving. What it buys is the whole point of a progressive reveal: the
    // frame shown large is the one that lands first, instead of the visitor
    // watching an empty hero while three thumbnails fill in behind it.
    const renderable = captureOrder(plan);

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
          setBySlot((prev) => applyCaptureEvent(prev, event));
          return;
        case "view-captured": {
          metrics.recordCaptureLatency(event.elapsedMs);
          // The Map Tiles policy asks for all attributions for displayed tiles,
          // aggregated and sorted, in a line. Recomputed per arrival now rather
          // than once at the end, so the credit line is correct for whatever is
          // actually on screen at any moment.
          for (const credit of event.result.attribution) {
            if (credit) creditsRef.current.add(credit);
          }
          setAttribution(Array.from(creditsRef.current).sort().join(", "));
          setBySlot((prev) => applyCaptureEvent(prev, event));
          return;
        }
        case "view-failed":
          // The specific cause is an operator diagnostic, not visitor copy — it
          // goes to the console, never onto the screen.
          console.error(
            `[27b] direction ${event.slot} failed (attempt ${event.attempt}):`,
            event.failure.detail,
          );
          setBySlot((prev) => applyCaptureEvent(prev, event));
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
 * Fold one session event into the per-direction map.
 *
 * Pure, and outside the component on purpose: this is where the rule that a
 * landed frame is never taken away lives, and it is the rule most easily broken
 * by an ordinary-looking edit. Having it as a function means it can be driven
 * with an event sequence in a unit test rather than only by running a render.
 *
 * ONE INVARIANT ABOVE ALL: once a direction holds a real capture, no later
 * event of any kind removes it. A direction can fail after it has already
 * succeeded — a person spends the third attempt on a direction they thought
 * looked soft, or a re-capture runs into the session deadline — and the whole
 * slot used to be replaced, dropping the data URL with it. The picture then
 * vanished from a pane that had been showing it, and the empty pane took the
 * "didn't load" copy for a direction that plainly had. What failed is the
 * latest attempt, not the frame in hand.
 */
export function applyCaptureEvent(
  prev: TileCaptures["bySlot"],
  event: CaptureEvent,
): TileCaptures["bySlot"] {
  switch (event.kind) {
    case "session-open":
    case "session-closed":
      return prev;

    case "view-started": {
      const before = prev[event.slot];
      // Re-capturing a direction that already has a frame leaves the frame on
      // screen and marks it as being taken again. Swapping it for the empty
      // capturing pane would remove a real picture the reader is looking at in
      // order to report on an attempt that has produced nothing yet.
      const keepsFrame = before?.phase === "ready" && !!before.dataUrl;
      return {
        ...prev,
        [event.slot]: {
          ...(before ?? { attempts: 0 }),
          phase: keepsFrame ? "ready" : "capturing",
          recapturing: keepsFrame || undefined,
          attempts: event.attempt,
        },
      };
    }

    case "view-captured":
      return {
        ...prev,
        [event.result.slot]: {
          phase: "ready",
          dataUrl: event.result.dataUrl,
          settled: event.settled,
          recapturing: undefined,
          attempts: event.attempt,
        },
      };

    case "view-failed": {
      const before = prev[event.slot];
      if (before?.phase === "ready" && before.dataUrl) {
        return {
          ...prev,
          [event.slot]: {
            ...before,
            recapturing: undefined,
            attempts: event.attempt,
          },
        };
      }
      return {
        ...prev,
        [event.slot]: {
          // A direction that is going to be retried is still in flight, not
          // finished. Showing it as failed and then un-failing it would be a
          // state the app invented.
          phase: event.willRetry ? "queued" : "failed",
          attempts: event.attempt,
        },
      };
    }
  }
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
 * A direction that already holds a frame is left exactly as it is, and so is
 * one nothing was ever requested for.
 *
 * Returns the same object when there is nothing to change, so React does not
 * re-render on every settled session.
 */
export function concludeUnfinished(
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
