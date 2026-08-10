// Render-session orchestration: turn a frame-by-frame capture source into an
// ordered stream of events, with per-direction failure and per-direction retry.
//
// WHY THIS FILE EXISTS SEPARATELY FROM tileRenderer.ts
//
// tileRenderer.ts owns everything Cesium: the WebGL context, the tileset, the
// settle loop, the canvas readback. This file owns the *policy* — what happens
// when one direction fails, how many times a direction may be re-attempted,
// what order events arrive in, what abort means. Splitting them is what makes
// the policy testable: `renderSession.test.ts` drives a fake `FrameSource` with
// no Cesium, no WebGL, no API key, and no provider request.
//
// THE BUG THIS REPLACES
//
// The previous `renderFourViews()` captured all four views in one loop and
// returned a `CaptureResult[]` only after the last one finished. Two
// consequences, both fixed here:
//
//   1. Frames were *withheld, not awaited*. Each was complete in hand at the
//      end of its iteration; the first existed at roughly 10-16 s and was not
//      shown until 37-62 s.
//   2. One throw destroyed everything. A canvas-readback SecurityError on the
//      third view propagated out of the whole function, discarding the two
//      finished frames already in the local array. That is data loss
//      independent of any UX question.

import type {
  CameraView,
  CaptureEvent,
  CaptureResult,
  RenderFailure,
  RenderSession,
  SessionCloseReason,
  ViewSlot,
} from "../lib/types";
import { describeError } from "../lib/redact";

/**
 * The Cesium-shaped hole this module drives. `tileRenderer.ts` supplies the
 * real one; tests supply a fake.
 */
export interface FrameSource {
  /**
   * Capture one view. Rejects with a `CaptureFailedError` (or anything else —
   * anything not classified is treated as a retryable capture failure).
   */
  capture(view: CameraView): Promise<{ result: CaptureResult; settled: boolean }>;
  /** Tear down the WebGL context. Must be idempotent. */
  close(): void;
}

/**
 * A failure the source can classify for us. `fatalForSession: true` means the
 * same thing will happen to every remaining direction — a tainted canvas, for
 * instance — so the session stops rather than burning 16 s per view proving it.
 */
export class CaptureFailedError extends Error {
  constructor(readonly failure: RenderFailure) {
    super(failure.detail);
    this.name = "CaptureFailedError";
  }
}

/**
 * Attempts a direction gets automatically, including the first.
 *
 * 2 not 3: a retry inside an open session is free in provider terms, but it
 * costs the visitor up to 16 s of wall clock, and a direction that failed twice
 * for the same reason will very likely fail a third time. The third attempt is
 * held back for a person to spend deliberately via `recapture()`.
 */
export const MAX_AUTO_ATTEMPTS_PER_SLOT = 2;

/** Hard ceiling per direction per session, automatic and manual combined. */
export const MAX_ATTEMPTS_PER_SLOT = 3;

/**
 * Longest one attempt at one direction may take before the session gives up on
 * it and moves to the next, milliseconds.
 *
 * This is a BACKSTOP, not a capture budget. The renderer already bounds its own
 * wait — `RENDER_TUNING.settleTimeoutMs` (16 s), multiplied by
 * `FIRST_CAPTURE_SETTLE_FACTOR` (2.5) for the first direction of a session,
 * plus a second of texture-upload settling — which puts the renderer's own
 * worst case at roughly 42 s for the first direction and 17 s for every one
 * after it. 60 s sits above both, so this fires only when the renderer has
 * stopped returning at all, which is the one case its own timeout cannot cover.
 *
 * Without it a single wedged capture holds the other three directions behind it
 * for as long as the page is open, and every one of them shows as still
 * queued — the app claiming work is in progress that is not.
 */
export const DIRECTION_DEADLINE_MS = 60_000;

/**
 * Longest a whole session may run before it closes with whatever it has,
 * milliseconds.
 *
 * The per-direction deadline bounds one attempt; this bounds their sum. Four
 * directions at the renderer's own worst case is about 3 s of warm-up plus 42 s
 * plus three times 17 s, i.e. ~96 s with no retries at all, and the retry
 * budget can add two more attempts on top. 105 s is above the no-retry worst
 * case and below the retrying one on purpose: a retry that would push the wait
 * past this point is not worth the visitor's time, and three directions in 105
 * seconds is a real result where four in three minutes is an abandoned page.
 *
 * The longest end-to-end time actually measured over the pre-registered matrix
 * is 65 s, so on the evidence available this truncates nothing that works.
 */
export const SESSION_DEADLINE_MS = 105_000;

export interface RenderSessionOptions {
  signal?: AbortSignal;
  maxAutoAttemptsPerSlot?: number;
  maxAttemptsPerSlot?: number;
  /** Backstop for one attempt at one direction. See DIRECTION_DEADLINE_MS. */
  directionDeadlineMs?: number;
  /** Backstop for the whole session. See SESSION_DEADLINE_MS. */
  sessionDeadlineMs?: number;
  now?: () => number;
}

/**
 * Resolve to `work`'s value, or to the `timeout` sentinel once `ms` have
 * elapsed, whichever happens first.
 *
 * The losing capture is NOT cancelled — the renderer has no cancel short of
 * destroying the WebGL context, and destroying it would take the directions
 * that have not run yet with it. It is abandoned instead: its eventual
 * settlement is dropped on the floor here, so a capture that comes back after
 * its deadline can neither emit an event nor overwrite a slot that has since
 * moved on. The rejection handler is what keeps that abandonment from surfacing
 * as an unhandled rejection.
 */
function withDeadline<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false } as const), ms);
  });
  const wrapped = work.then((value) => ({ done: true, value }) as const);
  // Marks the abandoned branch as handled without consuming it: the race below
  // still sees the rejection when the capture loses on time rather than on the
  // clock.
  wrapped.catch(() => {});
  return Promise.race([wrapped, expiry]).finally(() => clearTimeout(timer));
}

/**
 * A single-consumer async event channel.
 *
 * Hand-rolled rather than reached for as a library because the semantics
 * matter and are three lines each: pushes never block, a consumer that is
 * behind gets buffered events in order, and `end()` is sticky.
 */
class EventChannel<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.buffer.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const w of this.waiters) w({ value: undefined as never, done: true });
    this.waiters = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift() as T, done: false });
        }
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

interface WorkItem {
  view: CameraView;
  attempt: number;
  /** Set for manual `recapture()` calls so the caller learns the outcome. */
  settle?: (event: CaptureEvent) => void;
}

/**
 * Drive `source` over `views`, emitting each frame the moment it exists.
 *
 * Ordering guarantees, all asserted in tests:
 *   - `session-open` is the first event and carries `rootRequests: 1`.
 *   - Every direction produces at least one terminal event
 *     (`view-captured` or a `view-failed` with `willRetry: false`), unless the
 *     session was aborted or ended fatally first.
 *   - `session-closed` is the last event and is emitted exactly once.
 *   - Nothing is emitted after abort except `session-closed`.
 */
export function createRenderSession(
  views: CameraView[],
  source: FrameSource,
  opts: RenderSessionOptions = {},
): RenderSession {
  const {
    signal,
    maxAutoAttemptsPerSlot = MAX_AUTO_ATTEMPTS_PER_SLOT,
    maxAttemptsPerSlot = MAX_ATTEMPTS_PER_SLOT,
    directionDeadlineMs = DIRECTION_DEADLINE_MS,
    sessionDeadlineMs = SESSION_DEADLINE_MS,
    now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  } = opts;

  const channel = new EventChannel<CaptureEvent>();
  const queue: WorkItem[] = views.map((view) => ({ view, attempt: 1 }));
  const bySlot = new Map<ViewSlot, CameraView>(views.map((v) => [v.slot, v]));
  /**
   * Attempts *reserved* per slot, not attempts started. Counted at enqueue
   * time so that two `recapture()` calls made back-to-back — before the worker
   * has picked either up — take attempt 3 and attempt 4 rather than both
   * claiming attempt 3 and slipping past the cap.
   */
  const reservedBySlot = new Map<ViewSlot, number>(views.map((v) => [v.slot, 1]));

  let open = true;
  /** The item the worker is currently awaiting, so an abort can settle it. */
  let inFlight: WorkItem | null = null;

  const abandoned = (item: WorkItem, detail: string): CaptureEvent => ({
    kind: "view-failed",
    slot: item.view.slot,
    failure: { kind: "capture-failed", detail, fatalForSession: false },
    attempt: item.attempt,
    willRetry: false,
  });

  const closeSession = (reason: SessionCloseReason) => {
    if (!open) return;
    open = false;
    signal?.removeEventListener("abort", onAbort);
    try {
      source.close();
    } catch {
      // Already torn down, or torn down mid-teardown. Nothing more to do.
    }
    channel.push({ kind: "session-closed", reason });
    channel.end();
    // Manual recaptures still queued (or in flight) get a definitive answer
    // rather than a promise that never settles.
    const stranded = queue.splice(0);
    if (inFlight) stranded.unshift(inFlight);
    inFlight = null;
    for (const item of stranded) {
      item.settle?.(abandoned(item, "Session closed before this direction was re-captured."));
    }
  };

  function onAbort() {
    closeSession("aborted");
  }
  signal?.addEventListener("abort", onAbort, { once: true });

  function classify(err: unknown): RenderFailure {
    if (err instanceof CaptureFailedError) return err.failure;
    // `describeError`, not the raw message. RenderFailure.detail is documented
    // in types.ts as having any `key=` parameter redacted, and this is the path
    // that did not honour it: anything thrown out of `source.capture()` that is
    // not already a CaptureFailedError -- a Cesium RuntimeError out of
    // `render()` or `applyCameraView` -- arrived verbatim and was console.error'd
    // by the consumer. A provider error carrying the request URL carries the key.
    return {
      kind: "capture-failed",
      detail: describeError(err),
      fatalForSession: false,
    };
  }

  async function worker(): Promise<void> {
    const sessionStarted = now();
    /** What is left of the whole-session budget, never below zero. */
    const sessionRemainingMs = () =>
      Math.max(0, sessionDeadlineMs - (now() - sessionStarted));

    channel.push({ kind: "session-open", rootRequests: 1 });

    while (open) {
      if (sessionRemainingMs() === 0) {
        // Out of time with work still queued. Close rather than start a capture
        // whose result nobody will wait for; the consumer marks everything that
        // never reached a terminal event as not loaded, and keeps every frame
        // that did land.
        closeSession("deadline");
        break;
      }

      const item = queue.shift();
      if (!item) {
        // Nothing queued. If every direction has reached a terminal state and
        // no manual recapture is pending, the session is done. There is no
        // idle hold: keeping the WebGL context alive to make a later
        // per-direction retry free was proposed and declined this sprint, so
        // the context goes away as soon as the work does.
        closeSession("complete");
        break;
      }

      const { view, attempt } = item;
      inFlight = item;
      channel.push({ kind: "view-started", slot: view.slot, attempt });

      const started = now();
      // One race, two bounds: this attempt gets the smaller of its own deadline
      // and whatever is left of the session's. Taking the minimum is what stops
      // a last direction started at second 104 from running to second 164.
      const budgetMs = Math.min(directionDeadlineMs, sessionRemainingMs());
      let event: CaptureEvent;
      try {
        const outcome = await withDeadline(source.capture(view), budgetMs);
        if (!open) break; // aborted while this capture was in flight
        inFlight = null;
        if (!outcome.done) {
          throw new CaptureFailedError({
            kind: "capture-failed",
            detail:
              `Direction ${view.slot} did not return within ${Math.round(budgetMs)} ms ` +
              `(attempt ${attempt}). The capture was abandoned, not cancelled.`,
            fatalForSession: false,
          });
        }
        const { result, settled } = outcome.value;
        event = {
          kind: "view-captured",
          result,
          settled,
          elapsedMs: now() - started,
          attempt,
        };
      } catch (err) {
        if (!open) break;
        inFlight = null;
        const failure = classify(err);
        // Decided against the reservation counter, not against this item's own
        // attempt number, so an automatic retry never double-books a slot for
        // which a person has already asked for one.
        const reserved = reservedBySlot.get(view.slot) ?? attempt;
        const willRetry =
          !failure.fatalForSession && reserved < maxAutoAttemptsPerSlot;
        event = {
          kind: "view-failed",
          slot: view.slot,
          failure,
          attempt,
          willRetry,
        };
        if (willRetry) {
          // Re-queued at the BACK, not retried in place: the other three
          // directions should not wait behind a direction that is having
          // trouble, and a transient problem gets time to clear.
          reservedBySlot.set(view.slot, reserved + 1);
          queue.push({ view, attempt: reserved + 1 });
        }
        channel.push(event);
        item.settle?.(event);
        if (failure.fatalForSession) {
          closeSession("fatal");
          break;
        }
        continue;
      }

      channel.push(event);
      item.settle?.(event);
    }
  }

  void worker();

  return {
    events: channel,
    get isOpen() {
      return open;
    },
    close() {
      closeSession("aborted");
    },
    recapture(slot: ViewSlot): Promise<CaptureEvent> {
      const view = bySlot.get(slot);
      const attempt = (reservedBySlot.get(slot) ?? 0) + 1;
      if (!open || !view || attempt > maxAttemptsPerSlot) {
        return Promise.resolve({
          kind: "view-failed",
          slot,
          failure: {
            kind: "capture-failed",
            detail: !open
              ? "Session is closed; a new render is required."
              : `Retry limit reached for ${slot}.`,
            fatalForSession: false,
          },
          attempt: attempt - 1,
          willRetry: false,
        });
      }
      // The worker picks this up when the capture it is currently awaiting
      // finishes. No wake-up is needed: the session closes the moment the
      // queue drains, so there is never a parked worker to wake.
      reservedBySlot.set(slot, attempt);
      return new Promise<CaptureEvent>((resolve) => {
        queue.push({ view, attempt, settle: resolve });
      });
    },
  };
}
