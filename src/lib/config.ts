// Runtime configuration + the imagery-source key gate.
//
// The entire renderer is gated behind VITE_GOOGLE_MAPS_KEY. This is a hard
// product rule (see CLAUDE.md #1): with no key configured, the app must NOT show
// a placeholder or simulated scene — it shows the honest "imagery source not
// configured" state. The geometry pipeline (geocode, footprint, camera math,
// caching, metrics) runs fully without a key, so everything except the final
// real render is exercisable in this environment.

/** The Google Maps Platform key that unlocks Photorealistic 3D Tiles. */
export function googleMapsKey(): string | undefined {
  const key = import.meta.env.VITE_GOOGLE_MAPS_KEY;
  return typeof key === "string" && key.trim() !== "" ? key.trim() : undefined;
}

/** True when a real imagery source is configured. */
export function hasImagerySource(): boolean {
  return googleMapsKey() !== undefined;
}
