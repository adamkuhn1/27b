import { useCallback, useEffect, useRef, useState } from "react";
import { AddressForm, type AddressFormValue } from "./ui/AddressForm";
import {
  LoadingState,
  UnavailableState,
  NoImagerySourceState,
} from "./ui/States";
import { MetricsPanel } from "./ui/MetricsPanel";
import { ResultView } from "./ui/ResultView";
import { planView } from "./pipeline/planView";
import { hasImagerySource } from "./lib/config";
import type { ViewPlanResult } from "./lib/types";

type UiState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "result"; result: ViewPlanResult };

export default function App() {
  const [ui, setUi] = useState<UiState>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const imagerySource = hasImagerySource();

  // Portfolio embed contract (apps/portfolio/src/lib/embedProtocol.ts): once
  // the first frame has painted — the address form is interactive immediately —
  // tell the shell to crossfade its loading veil out. rAF defers past the
  // commit so we announce a painted frame, not just a mounted tree. No-op when
  // running standalone.
  useEffect(() => {
    if (window.parent === window) return;
    const raf = requestAnimationFrame(() => {
      window.parent.postMessage(
        { source: "portfolio-embed", type: "ready", id: "27b" },
        "*",
      );
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleSubmit = useCallback(async (value: AddressFormValue) => {
    // Cancel any in-flight request so a fast re-search doesn't race.
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setUi({ kind: "loading" });
    try {
      const result = await planView(value.address, value.floor, ac.signal);
      if (!ac.signal.aborted) setUi({ kind: "result", result });
    } catch (err) {
      // AbortError from a superseded request — ignore; a newer one is running.
      if (err instanceof DOMException && err.name === "AbortError") return;
      setUi({
        kind: "result",
        result: {
          ok: false,
          reason: "network-error",
          message: "Unexpected error. Please try again.",
        },
      });
    }
  }, []);

  return (
    <div className="app">
      <div className="app__inner">
        <header className="masthead">
          <div>
            <p className="masthead__tag">Portfolio Suite · 27B</p>
            <h1 className="masthead__title">
              What would you see from <span>floor 27B</span>?
            </h1>
            <p className="masthead__sub">
              Type a New York City address and a floor. 27B places a virtual
              camera at the building's real coordinates and floor height inside
              Google's photorealistic 3D reconstruction of the city, then looks
              out in each cardinal direction.
            </p>
          </div>
        </header>

        <AddressForm onSubmit={handleSubmit} busy={ui.kind === "loading"} />

        <p className="framing">
          These are <strong>approximately what you'd see</strong> — not your
          actual view. Floor height is estimated (NYC building data has no
          per-floor field), and the imagery is Google's real 3D capture of the
          city, so expect the vantage to be close, not exact.
        </p>

        {ui.kind === "loading" && <LoadingState />}

        {ui.kind === "result" && !ui.result.ok && (
          <UnavailableState
            reason={ui.result.reason}
            message={ui.result.message}
          />
        )}

        {ui.kind === "result" &&
          ui.result.ok &&
          (imagerySource ? (
            <ResultView result={ui.result} />
          ) : (
            <>
              <ResultView result={ui.result} renderDisabled />
              <NoImagerySourceState />
            </>
          ))}

        <MetricsPanel />
      </div>

      <footer className="foot">
        Imagery, when configured, is Google Photorealistic 3D Tiles rendered in
        CesiumJS. Building height &amp; ground elevation from NYC OpenData
        Building Footprints. Geocoding by NYC Planning GeoSearch. 27B never
        fabricates a scene — no data means the honest “not available” state.
      </footer>
    </div>
  );
}
