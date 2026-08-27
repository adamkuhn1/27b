import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import cesium from "vite-plugin-cesium";

// Resolve Cesium's build dir absolutely rather than relying on
// vite-plugin-cesium's default of a CWD-local "node_modules/cesium/Build".
const require = createRequire(import.meta.url);
const cesiumPkg = require.resolve("cesium/package.json");
const cesiumBuild = path.join(path.dirname(cesiumPkg), "Build");

/**
 * Cesium, loaded only when a render actually happens.
 *
 * vite-plugin-cesium's default production mode marks `cesium` as a Rollup
 * external mapped to a global, and injects a render-blocking
 * `<script src="cesium/Cesium.js">` (1.7 MB gzipped) into every page — so
 * every visitor would pay for the whole 3D engine before the address input
 * exists, and the dynamic `import("./viewer/tileRenderer")` in App.tsx would
 * buy nothing.
 *
 * 1. `rebuildCesium: true` compiles Cesium from ESM source into the dependency
 *    graph, so Rollup puts it in the chunk reachable only from the dynamic
 *    import. The plugin still copies Cesium's static runtime assets into
 *    `dist/cesium/` and sets CESIUM_BASE_URL.
 * 2. Dropping the plugin's `transformIndexHtml` hook keeps the widgets
 *    stylesheet out of `<head>`; tileRenderer.ts imports it into the same
 *    lazy chunk.
 *
 * Cost of the trade: `vite build` compiles Cesium from source (~25 s instead
 * of ~0.4 s). Build time, not visitor time.
 */
function lazyCesium(): Plugin {
  const plugin = cesium({
    rebuildCesium: true,
    cesiumBuildRootPath: cesiumBuild,
    cesiumBuildPath: path.join(cesiumBuild, "Cesium/"),
  });
  return { ...plugin, transformIndexHtml: undefined };
}

// base: "./" keeps built asset paths relative so the app works when served
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
    // Unit tests are pure geometry/text math and run in Node.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
