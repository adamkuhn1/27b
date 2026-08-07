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

export interface RenderSessionOptions {
  signal?: AbortSignal;
  maxAutoAttemptsPerSlot?: number;
  maxAttemptsPerSlot?: number;
  now?: () => number;
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
    channel.push({ kind: "session-open", rootRequests: 1 });

    while (open) {
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
      let event: CaptureEvent;
      try {
        const { result, settled } = await source.capture(view);
        if (!open) break; // aborted while this capture was in flight
        inFlight = null;
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
