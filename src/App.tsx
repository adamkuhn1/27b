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

interface Preset {
  name: string;
  address: string;
  floor: number;
  detail: string;
}

const PRESETS: Preset[] = [
  {
    name: "Empire State Bldg",
    address: "350 5th Ave, Manhattan, New York, NY 10118",
    floor: 80,
    detail: "fl. 80 · Midtown Manhattan",
  },
  {
    name: "One World Trade",
    address: "285 Fulton St, Manhattan, New York, NY 10007",
    floor: 100,
    detail: "fl. 100 · Lower Manhattan",
  },
  {
    name: "432 Park Avenue",
    address: "432 Park Ave, Manhattan, New York, NY 10022",
    floor: 80,
    detail: "fl. 80 · Midtown Manhattan",
  },
  {
    name: "Chrysler Building",
    address: "405 Lexington Ave, Manhattan, New York, NY 10174",
    floor: 60,
    detail: "fl. 60 · Midtown East",
  },
  {
    name: "30 Rockefeller Plaza",
    address: "30 Rockefeller Plaza, Manhattan, New York, NY 10112",
    floor: 65,
    detail: "fl. 65 · Rockefeller Ctr",
  },
  {
    name: "The Dakota",
    address: "1 W 72nd St, Manhattan, New York, NY 10023",
    floor: 10,
    detail: "fl. 10 · Upper West Side",
  },
];

interface BuildingPresetsProps {
  onSelect: (value: AddressFormValue) => void;
  busy: boolean;
}

function BuildingPresets({ onSelect, busy }: BuildingPresetsProps) {
  return (
    <div className="presets">
      <span className="presets__label">NYC landmarks</span>
      <div className="presets__row">
        {PRESETS.map((p) => (
          <button
            key={p.address}
            type="button"
            className="preset"
            disabled={busy}
            onClick={() => onSelect({ address: p.address, floor: p.floor })}
          >
            <span className="preset__name">{p.name}</span>
            <span className="preset__detail">{p.detail}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

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
          <p className="masthead__tag">27B · real-geometry floor views · New York City</p>
          <h1 className="masthead__title">
            What would you see from <span>floor 27B</span>?
          </h1>
          <p className="masthead__sub">
            Type any NYC address and a floor number. 27B finds the building,
            estimates the camera height, and renders what you'd see looking
            north, south, east, and west — using Google's real photorealistic
            3D capture of the city, not a model or simulation.
          </p>
        </header>

        <AddressForm onSubmit={handleSubmit} busy={ui.kind === "loading"} />

        <BuildingPresets
          onSelect={handleSubmit}
          busy={ui.kind === "loading"}
        />

        <p className="framing">
          These are <strong>approximately what you'd see</strong> — not your
          exact view. Floor height is estimated from building footprint data
          (NYC doesn't publish per-floor heights), so the vantage is close but
          not precise. The imagery is always real — never substituted.
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
        <div className="foot__inner">
          <div className="foot__sources">
            <span>Imagery: Google Photorealistic 3D Tiles via CesiumJS</span>
            <span>Buildings: NYC OpenData Building Footprints</span>
            <span>Geocoding: NYC Planning GeoSearch</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
