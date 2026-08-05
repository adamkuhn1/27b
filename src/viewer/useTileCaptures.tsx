import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CaptureMap } from "../lib/cache";
import { googleMapsKey } from "../lib/config";
import type { ViewPlan } from "../lib/types";

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

type CaptureState = "idle" | "loading" | "ready" | "error";

interface TileCaptures {
  state: CaptureState;
  bySlot: CaptureMap;
  /** Aggregated Google data attribution for the frames on screen. */
  attribution?: string;
  /** Human-readable diagnostic when state === "error". */
  errorMsg?: string;
}

const CapturesContext = createContext<TileCaptures>({
  state: "idle",
  bySlot: {},
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
    bySlot: {},
  });
  // Guard against double-run (React 18 StrictMode) and stale plan updates.
  const runIdRef = useRef(0);

  useEffect(() => {
    if (disabled) {
      setCaptures({ state: "idle", bySlot: {} });
      return;
    }

    const key = googleMapsKey();
    if (!key) {
      // Belt-and-suspenders: no key => never touch the renderer.
      setCaptures({ state: "idle", bySlot: {} });
      return;
    }

    const runId = ++runIdRef.current;

    setCaptures({ state: "loading", bySlot: {} });

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
        for (const r of results) map[r.slot] = r.dataUrl;
        // Union of the per-frame credits, sorted — the Map Tiles policy asks for
        // all attributions for displayed tiles, aggregated and sorted, in a line.
        const attribution = Array.from(
          new Set(results.flatMap((r) => r.attribution).filter(Boolean)),
        )
          .sort()
          .join(", ");
        setCaptures({ state: "ready", bySlot: map, attribution });
      } catch (err) {
        if (runId !== runIdRef.current) return; // superseded — includes our own abort
        // Cesium tile-load errors can embed the failing request URL, and the
        // Map Tiles key rides in that URL's query string. The key is already
        // public in the built bundle, but there's no reason to additionally
        // put it in an error message a user might screenshot or paste into a
        // bug report -- strip any `key=...` query param before it's ever
        // stored or rendered. Same principle as proof/run-proof.mjs's
        // "never log the key" query-string strip.
        const rawMsg = err instanceof Error ? err.message : String(err);
        const raw = rawMsg.replace(/([?&]key=)[^&\s"']+/gi, "$1[redacted]");
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
        setCaptures({ state: "error", bySlot: {}, errorMsg: msg });
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

/** Read the shared capture state for the current view frame. */
export function useTileCaptures(disabled?: boolean): TileCaptures {
  const ctx = useContext(CapturesContext);
  if (disabled) return { state: "idle", bySlot: {} };
  return ctx;
}
