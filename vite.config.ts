/// <reference types="vitest/config" />
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cesium from "vite-plugin-cesium";

// Cesium is hoisted to the monorepo root node_modules, so resolve its build dir
// absolutely rather than relying on vite-plugin-cesium's default of a CWD-local
// "node_modules/cesium/Build". require.resolve finds the package wherever npm
// hoisted it, keeping the app portable across install layouts.
const require = createRequire(import.meta.url);
const cesiumPkg = require.resolve("cesium/package.json");
const cesiumBuild = path.join(path.dirname(cesiumPkg), "Build");

// base: "./" keeps built asset paths relative so each app works when served
// standalone AND when embedded in the portfolio shell via iframe.
export default defineConfig({
  plugins: [
    react(),
    cesium({
      cesiumBuildRootPath: cesiumBuild,
      cesiumBuildPath: path.join(cesiumBuild, "Cesium/"),
    }),
  ],
  base: "./",
  test: {
    // Unit tests for geometry/elevation/validation math run in Node (jsdom is
    // only pulled in for the storage-backed cache test).
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
