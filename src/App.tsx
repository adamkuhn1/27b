import { useCallback, useEffect, useRef, useState } from "react";
import { AddressForm, type AddressFormValue } from "./ui/AddressForm";
import {
  LoadingState,
  UnavailableState,
  NoImagerySourceState,
} from "./ui/States";
import { ResultView } from "./ui/ResultView";
import { planView } from "./pipeline/planView";
import { hasImagerySource } from "./lib/config";
import { purgeRetiredCaptureCache } from "./lib/cache";
import type { ViewPlanResult } from "./lib/types";

// One-time cleanup: builds before 2026-08-04 persisted rendered Google tile
// imagery to localStorage. That is not permitted under Google Maps Platform ToS
// §3.2.3(b) (no caching of Google Maps Content absent a service-specific
// allowance, and the Maps Service Specific Terms grant none for Map Tiles), so
// any such data left in a returning visitor's browser is deleted at startup
// rather than merely ignored.
purgeRetiredCaptureCache();

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

// Mostly buildings people actually live in, because that is what this is for.
// The two landmarks are here because they are the cases a New Yorker will try
// first, not because the app is a tour of them.
//
// ORDER IS DELIBERATE, and it was wrong until 2026-08-08. 425 E 79th was first
// because it is the most interesting case in the app: a floor-10 walk-up with a
// party wall on one side and a 4 m light court on another, which is the whole
// point of the enclosure work. It is also, for exactly that reason, the worst
// picture of the five — three of its four directions are a close-range facade
// two metres away, which is what the provider's mesh renders worst
// (proof/presets-verification/frames/425-e79-nne-close-range.png). Whoever clicked the first
// button saw a smear and concluded the renderer was broken.
//
// So the order now runs from the clearest view to the most enclosed one. The
// hard case is still here and still labelled; it is just no longer the opening
// argument. Every one of these was rendered and looked at before this list was
// reordered — see proof/verify-presets.mjs.
const PRESETS: Preset[] = [
  {
    name: "432 Park Ave",
    address: "432 Park Ave, Manhattan, New York, NY 10022",
    floor: 80,
    detail: "floor 80 · over Central Park",
  },
  {
    name: "Empire State Bldg",
    address: "350 5th Ave, Manhattan, New York, NY 10118",
    floor: 80,
    detail: "floor 80 · Midtown",
  },
  {
    name: "The Dakota",
    address: "1 W 72nd St, Manhattan, New York, NY 10023",
    floor: 7,
    detail: "floor 7 · Upper West Side",
  },
  {
    name: "175 Fifth Ave",
    address: "175 5th Ave, Manhattan, New York, NY 10010",
    floor: 18,
    detail: "floor 18 · the Flatiron",
  },
  {
    name: "425 E 79th St",
    address: "425 E 79th St, Manhattan, New York, NY 10075",
    floor: 10,
    detail: "floor 10 · hemmed in on three sides",
  },
];

interface BuildingPresetsProps {
  onSelect: (value: AddressFormValue) => void;
  busy: boolean;
}

function BuildingPresets({ onSelect, busy }: BuildingPresetsProps) {
  return (
    <div className="presets">
      <span className="presets__label">Or try one of these</span>
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
  // Changing this remounts the result, which opens a new render session. It is
  // the only way to re-render after a session has closed, and it costs one root
  // tileset request — the same as re-rendering all four directions, which is
  // why the UI never offers a cheaper-looking per-direction retry once the
  // session is gone.
  const [renderAttempt, setRenderAttempt] = useState(0);
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
    setRenderAttempt(0);

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
          {/*
            "What would you see from floor 27B?" read as an instruction to type
            27B into the floor box. 27B is the name of the thing, not a value
            you enter, and the two inputs are an address and a floor number.
          */}
          <p className="masthead__tag">
            <span className="masthead__mark">27B</span> — New York City only
          </p>
          <h1 className="masthead__title">What would you see from that floor?</h1>
          <p className="masthead__sub">
            Before you go and look at an apartment, see roughly what its floor
            looks out on. Give it a New York address and a floor number: it
            finds the building, works out how high that floor sits, and looks
            out along each of the building's walls using real captured imagery
            of the city.
          </p>
        </header>

        <AddressForm onSubmit={handleSubmit} busy={ui.kind === "loading"} />

        <BuildingPresets
          onSelect={handleSubmit}
          busy={ui.kind === "loading"}
        />

        <p className="framing">
          <strong>Approximately what you'd see</strong>, not the view from a
          particular apartment. Nobody publishes per-floor heights, so the
          height of your floor is estimated, and the four directions come from
          the shape of the building rather than from a floor plan. The imagery
          is always real, or absent — never a stand-in.
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
            <ResultView
              key={renderAttempt}
              result={ui.result}
              onRenderAgain={() => setRenderAttempt((n) => n + 1)}
            />
          ) : (
            <>
              <ResultView result={ui.result} renderDisabled />
              <NoImagerySourceState />
            </>
          ))}
      </div>

      <footer className="foot">
        <div className="foot__inner">
          <div className="foot__sources">
            <span>Imagery: Google Maps (Photorealistic 3D Tiles, via CesiumJS)</span>
            <span>Buildings: NYC OpenData Building Footprints</span>
            <span>Geocoding: NYC Planning GeoSearch</span>
            <span>Vertical datum: NOAA NGS GEOID18</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
