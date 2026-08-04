import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CaptureMap } from "../lib/cache";
import { readCaptures, writeCaptures } from "../lib/cache";
import { googleMapsKey } from "../lib/config";
import type { ViewPlan } from "../lib/types";

// The four cardinal captures are produced ONCE per plan (a single Cesium
// session, four static frames) and shared across the four CesiumView frames via
// context. This is what keeps the app to one tile-loading session per address
// instead of four live globes. A cache hit renders zero tiles.

type CaptureState = "idle" | "loading" | "ready" | "error";

interface TileCaptures {
  state: CaptureState;
  byCardinal: CaptureMap;
  /** Human-readable diagnostic when state === "error". */
  errorMsg?: string;
}

const CapturesContext = createContext<TileCaptures>({
  state: "idle",
  byCardinal: {},
  errorMsg: undefined,
});

/**
 * Provider that renders the four captures for a plan (or loads them from cache)
 * and exposes them to descendant CesiumView frames.
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
  const [captures, setCaptures] = useState<TileCaptures>({
    state: disabled ? "idle" : "loading",
    byCardinal: {},
  });
  // Guard against double-run (React 18 StrictMode) and stale plan updates.
  const runIdRef = useRef(0);

  useEffect(() => {
    if (disabled) {
      setCaptures({ state: "idle", byCardinal: {} });
      return;
    }

    const key = googleMapsKey();
    if (!key) {
      // Belt-and-suspenders: no key => never touch the renderer.
      setCaptures({ state: "idle", byCardinal: {} });
      return;
    }

    const runId = ++runIdRef.current;
    const bin = plan.footprint.bin;

    // Cache hit: render nothing, spend no tile events.
    const cached = readCaptures(bin, plan.floor);
    if (cached && Object.keys(cached).length > 0) {
      setCaptures({ state: "ready", byCardinal: cached });
      return;
    }

    setCaptures({ state: "loading", byCardinal: {} });

    // Ties the Cesium session's lifetime to this effect. Without this, React
    // 18 StrictMode's double-invoke (or a plan change) leaves the first run's
    // viewer alive in the background — a second real WebGL context — and the
    // two fight over the GPU instead of the first one being torn down.
    const controller = new AbortController();

    // Lazily import the heavy Cesium renderer only on the real render path.
    (async () => {
      try {
        const { renderFourViews } = await import("./tileRenderer");
        const results = await renderFourViews(plan.views, {
          apiKey: key,
          signal: controller.signal,
        });
        if (runId !== runIdRef.current) return; // superseded
        const map: CaptureMap = {};
        for (const r of results) map[r.cardinal] = r.dataUrl;
        writeCaptures(bin, plan.floor, map);
        setCaptures({ state: "ready", byCardinal: map });
      } catch (err) {
        if (runId !== runIdRef.current) return; // superseded — includes our own abort
        const raw = err instanceof Error ? err.message : String(err);
        // Cesium errors may be RequestErrorEvent objects with a statusCode field
        // rather than standard Errors, so check both paths.
        const status = (err as { statusCode?: unknown }).statusCode;
        const is403 = status === 403 || /403|Forbidden/i.test(raw);
        const msg = is403
          ? "Map Tiles API returned 403 — enable it in Google Cloud Console (APIs & Services → Map Tiles API) and verify the key has no HTTP-referrer restrictions blocking localhost."
          : raw && raw !== "[object Object]"
            ? raw
            : "Tile rendering failed unexpectedly.";
        // Honest failure: an empty/error frame, never a fabricated scene.
        setCaptures({ state: "error", byCardinal: {}, errorMsg: msg });
      }
    })();

    return () => controller.abort();
  }, [plan, disabled]);

  return (
    <CapturesContext.Provider value={captures}>
      {children}
    </CapturesContext.Provider>
  );
}

/** Read the shared capture state for the current cardinal frame. */
export function useTileCaptures(disabled?: boolean): TileCaptures {
  const ctx = useContext(CapturesContext);
  if (disabled) return { state: "idle", byCardinal: {} };
  return ctx;
}
