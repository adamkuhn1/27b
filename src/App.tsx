// 27B — application shell and state machine.
//
// Flow: address + floor -> POST /api/view-plan (the Python backend's
// geometry pipeline -- see backend/planning.py) -> if the plan resolves and
// a key is configured, a single Cesium render session captures the four
// facade views progressively. Every failure branch lands in an explicit
// honest state; there is no fallback imagery of any kind.
//
// Cesium is imported dynamically here and nowhere else. The engine is ~1.7 MB
// gzipped, and a visitor who never gets past the form (or who only ever sees
// a not-supported state) should never pay for it.

import { useEffect, useRef, useState } from "react";
import { AddressForm, type AddressFormValue } from "./ui/AddressForm";
import { LoadingState, NoImagerySourceState, UnavailableState } from "./ui/States";
import { ResultView } from "./ui/ResultView";
import { planView, fetchCuratedBuildings } from "./lib/api";
import type { CuratedBuilding, ViewPlanResult, ViewSlot, ViewState } from "./lib/types";

/** The Google Maps Platform key that unlocks Photorealistic 3D Tiles. */
function googleMapsKey(): string | undefined {
  const key = import.meta.env.VITE_GOOGLE_MAPS_KEY;
  return typeof key === "string" && key.trim() !== "" ? key.trim() : undefined;
}

type ViewStates = Record<ViewSlot, ViewState>;

const ALL_PENDING: ViewStates = {
  V1: { kind: "pending" },
  V2: { kind: "pending" },
  V3: { kind: "pending" },
  V4: { kind: "pending" },
};

type UiState =
  | { kind: "idle" }
  | { kind: "planning" }
  | { kind: "result"; result: ViewPlanResult; viewStates: ViewStates };

export default function App() {
  const [state, setState] = useState<UiState>({ kind: "idle" });
  // One AbortController per lookup: a new search or an unmount supersedes the
  // running pipeline AND its render session (which owns a WebGL context).
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Fetched once from the backend (see lib/api.ts). Starts empty; the
  // picker and the not-supported state both render fine with zero chips
  // for the brief moment before this resolves.
  const [curatedBuildings, setCuratedBuildings] = useState<CuratedBuilding[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchCuratedBuildings().then((list) => {
      if (!cancelled) setCuratedBuildings(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const lookup = async ({ address, floor }: AddressFormValue) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ kind: "planning" });

    let result: ViewPlanResult;
    try {
      result = await planView(address, floor, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return; // superseded
      throw err;
    }
    if (controller.signal.aborted) return;

    setState({ kind: "result", result, viewStates: { ...ALL_PENDING } });
    if (!result.ok) return;

    const key = googleMapsKey();
    if (!key) return; // ResultView is not shown without a key — see render()

    const setSlot = (slot: ViewSlot, s: ViewState) => {
      setState((prev) =>
        prev.kind === "result"
          ? { ...prev, viewStates: { ...prev.viewStates, [slot]: s } }
          : prev,
      );
    };

    try {
      // Lazy: this import is what pulls Cesium into the page.
      const { renderViews } = await import("./viewer/tileRenderer");
      if (controller.signal.aborted) return;
      const outcomes = await renderViews(result.plan.views, {
        apiKey: key,
        signal: controller.signal,
        onViewStart: (slot) => setSlot(slot, { kind: "capturing" }),
      });
      for (const o of outcomes) {
        setSlot(
          o.slot,
          o.ok
            ? { kind: "ready", result: o.result }
            : { kind: "failed", detail: o.detail },
        );
      }
    } catch (err) {
      // A RenderAbortedError also lands here; the aborted check covers it.
      if (controller.signal.aborted) return;
      // Whole-session failure (bad key, no WebGL): every direction failed.
      console.error("[27b] render session failed:", err);
      setState((prev) =>
        prev.kind === "result"
          ? {
              ...prev,
              viewStates: {
                V1: { kind: "failed", detail: "session failed" },
                V2: { kind: "failed", detail: "session failed" },
                V3: { kind: "failed", detail: "session failed" },
                V4: { kind: "failed", detail: "session failed" },
              },
            }
          : prev,
      );
    }
  };

  return (
    <main className="app">
      <header className="masthead">
        <h1>
          <span className="mark">27B</span>
        </h1>
        <p className="tagline">
          See what a NYC apartment might face from a given floor. Enter a
          supported address and floor, and 27B generates four approximate
          views using Google's Photorealistic 3D Tiles.
        </p>
      </header>

      <AddressForm
        disabled={state.kind === "planning"}
        curatedBuildings={curatedBuildings}
        onSubmit={lookup}
      />

      {state.kind === "planning" && (
        <LoadingState label="Resolving the address and building geometry…" />
      )}

      {state.kind === "result" &&
        (!state.result.ok ? (
          <UnavailableState
            reason={state.result.reason}
            message={state.result.message}
            supportedFloors={state.result.supportedFloors}
            curatedBuildings={curatedBuildings}
          />
        ) : !googleMapsKey() ? (
          <NoImagerySourceState />
        ) : (
          <ResultView plan={state.result.plan} states={state.viewStates} />
        ))}
    </main>
  );
}
