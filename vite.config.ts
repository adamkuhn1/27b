import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import cesium from "vite-plugin-cesium";

// Cesium is hoisted to the monorepo root node_modules, so resolve its build dir
// absolutely rather than relying on vite-plugin-cesium's default of a CWD-local
// "node_modules/cesium/Build". require.resolve finds the package wherever npm
// hoisted it, keeping the app portable across install layouts.
const require = createRequire(import.meta.url);
const cesiumPkg = require.resolve("cesium/package.json");
const cesiumBuild = path.join(path.dirname(cesiumPkg), "Build");

/**
 * Cesium, loaded only when a render actually happens.
 *
 * `vite-plugin-cesium`'s default production mode marks `cesium` as a Rollup
 * external, maps it to the `Cesium` global, and injects
 * `<script src="cesium/Cesium.js">` into `<head>`. That prebuilt bundle is
 * 5,909,848 bytes (1.7 MB gzipped) and the tag is render-blocking, so **every**
 * visitor paid for the whole 3D engine before the address input existed —
 * including the majority who never submit a lookup. The dynamic
 * `import("./tileRenderer")` in `useTileCaptures.tsx` bought nothing, because
 * the expensive half had already been fetched and evaluated by then.
 *
 * Two changes fix it:
 *
 * 1. `rebuildCesium: true` makes the plugin skip both the external mapping and
 *    the script tag, so Cesium is compiled from its ESM source *into the
 *    dependency graph*. Rollup then puts it in the chunk reachable only from
 *    the dynamic import — which is the behaviour the lazy import always
 *    implied. The plugin still copies Cesium's static runtime assets
 *    (Assets/ThirdParty/Workers/Widgets) into `dist/cesium/` and still sets
 *    `CESIUM_BASE_URL` so they resolve at runtime.
 *
 * 2. Dropping the plugin's `transformIndexHtml` hook. Even with
 *    `rebuildCesium`, it injects `<link rel="stylesheet" href="cesium/Widgets/
 *    widgets.css">` (30,710 bytes) into `<head>` on every page. That stylesheet
 *    is only needed once a Cesium `Viewer` exists, so `tileRenderer.ts` imports
 *    it directly and Vite emits it as part of the same lazy chunk.
 *
 * Cost of the trade: Cesium is compiled from source, so `vite build` is slower
 * (measured: ~0.4 s -> ~25 s). That is build time, not visitor time.
 */
function lazyCesium(): Plugin {
  const plugin = cesium({
    rebuildCesium: true,
    cesiumBuildRootPath: cesiumBuild,
    cesiumBuildPath: path.join(cesiumBuild, "Cesium/"),
  });
  return { ...plugin, transformIndexHtml: undefined };
}

// base: "./" keeps built asset paths relative so each app works when served
// standalone AND when embedded in the portfolio shell via iframe.
export default defineConfig({
  plugins: [react(), lazyCesium()],
  base: "./",
  build: {
    // Cesium's ESM source is genuinely ~5 MB; the point of this build is that
    // it sits in a lazy chunk, not that it is small. Keep the warning for our
    // own code by raising the threshold above Cesium rather than silencing it.
    chunkSizeWarningLimit: 6000,
  },
  test: {
    // Unit tests for geometry/elevation/validation math run in Node (jsdom is
    // only pulled in for the storage-backed cache test).
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
