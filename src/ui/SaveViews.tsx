import { CARDINALS, CARDINAL_LABEL, type ViewPlan } from "../lib/types";
import { useTileCaptures } from "../viewer/useTileCaptures";

/** Trigger a browser download for a data-URL image. */
function download(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Slugify an address for a filename. */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Save the four captured views to disk. Only rendered when captures are ready —
 * there is nothing to save on the keyless path (no captures exist), so this UI
 * never implies a scene that wasn't produced from real tiles.
 */
export function SaveViews({ plan }: { plan: ViewPlan }) {
  const captures = useTileCaptures();
  if (captures.state !== "ready") return null;

  const available = CARDINALS.filter((c) => captures.byCardinal[c]);
  if (available.length === 0) return null;

  const base = `27b-${slug(plan.geocode.label)}-floor${plan.floor}`;

  function saveAll() {
    for (const c of available) {
      const url = captures.byCardinal[c];
      if (url) download(url, `${base}-${c}.png`);
    }
  }

  return (
    <div className="save">
      <button type="button" className="btn btn--ghost" onClick={saveAll}>
        Save {available.length} view{available.length > 1 ? "s" : ""} (
        {available.map((c) => CARDINAL_LABEL[c][0]).join("/")})
      </button>
      <span className="save__note">
        Saves the real rendered frames as PNGs. Filenames note the address and
        floor so the “approximately” framing travels with the image.
      </span>
    </div>
  );
}
