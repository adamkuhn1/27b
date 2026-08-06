/**
 * Strip provider credentials out of diagnostic text.
 *
 * Cesium tile-load errors can embed the failing request URL, and the Map Tiles
 * key rides in that URL's query string. The key is already public in the built
 * bundle (it has to be — the browser talks to `tile.googleapis.com` directly),
 * so this is not a secrecy control. It exists so a key never lands in an error
 * message someone screenshots or pastes into a bug report.
 *
 * This used to live inline in `useTileCaptures.tsx` and covered exactly one
 * error path. The streaming session has several, so it moved here: one function,
 * unit-tested, applied at every point where provider error text is captured.
 */
export function redactKey(text: string): string {
  return text.replace(/([?&]key=)[^&\s"']+/gi, "$1[redacted]");
}

/** Normalize any thrown value into redacted, human-readable text. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return redactKey(err.message);
  if (typeof err === "string") return redactKey(err);
  // Cesium errors can be RequestErrorEvent objects rather than Errors.
  const asRecord = err as { statusCode?: unknown; toString?: () => string };
  if (asRecord && typeof asRecord.statusCode === "number") {
    return `status ${asRecord.statusCode}`;
  }
  try {
    const s = String(err);
    return s === "[object Object]" ? "unknown error" : redactKey(s);
  } catch {
    return "unknown error";
  }
}
