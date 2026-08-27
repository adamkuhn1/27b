/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Google Maps Platform API key with the Map Tiles API (Photorealistic 3D
   * Tiles) enabled. Gates the entire renderer. Absent -> honest
   * "imagery source not configured" state; never a placeholder scene.
   */
  readonly VITE_GOOGLE_MAPS_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
