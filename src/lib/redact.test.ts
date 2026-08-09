import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describeError, redactKey } from "./redact";

describe("redactKey", () => {
  it("strips a key from a tile request URL", () => {
    expect(
      redactKey(
        "Failed to load https://tile.googleapis.com/v1/3dtiles/root.json?key=AIzaSyREAL_LOOKING_VALUE",
      ),
    ).toBe(
      "Failed to load https://tile.googleapis.com/v1/3dtiles/root.json?key=[redacted]",
    );
  });

  it("strips a key that is not the first parameter, and leaves the rest", () => {
    expect(redactKey("...?session=abc&key=SECRET&foo=bar")).toBe(
      "...?session=abc&key=[redacted]&foo=bar",
    );
  });

  it("is case-insensitive about the parameter name", () => {
    expect(redactKey("?KEY=SECRET")).toBe("?KEY=[redacted]");
  });

  it("stops at a quote, so a key inside a quoted URL is not swallowed whole", () => {
    expect(redactKey(`request to "https://x/?key=SECRET" failed`)).toBe(
      `request to "https://x/?key=[redacted]" failed`,
    );
  });

  it("leaves text with no key untouched", () => {
    expect(redactKey("403 Forbidden")).toBe("403 Forbidden");
  });
});

describe("describeError", () => {
  it("reads an Error message, redacted", () => {
    expect(describeError(new Error("boom ?key=SECRET"))).toBe("boom ?key=[redacted]");
  });

  it("handles a Cesium RequestErrorEvent, which is not an Error", () => {
    expect(describeError({ statusCode: 403 })).toBe("status 403");
  });

  it("never returns the useless [object Object]", () => {
    expect(describeError({ nothing: "useful" })).toBe("unknown error");
  });

  it("handles a thrown string", () => {
    expect(describeError("plain failure")).toBe("plain failure");
  });
});

// ---------------------------------------------------------------------------
// Source-shape guards on the two things a deployment review asks about: can the
// provider key escape into something a person will read, and does this app ever
// ask the browser where the visitor is.
//
// The key is necessarily present in the built bundle — the browser talks to
// tile.googleapis.com itself, so there is no version of this that hides it, and
// the control that matters is an HTTP-referrer restriction on the key rather
// than secrecy. What must never happen is the key turning up in an error
// message, a console line or on screen, because those get screenshotted and
// pasted into issues by people who have no idea it is in there.
// ---------------------------------------------------------------------------

const SRC_ROOT = join(__dirname, "..");

function productionSources(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx|css)$/.test(entry)) continue;
      if (/\.test\.tsx?$/.test(entry)) continue;
      out.push({ path: relative(SRC_ROOT, p), text: readFileSync(p, "utf8") });
    }
  };
  walk(SRC_ROOT);
  return out;
}

const PRODUCTION = productionSources();

describe("the provider key cannot reach a message, a log or the screen", () => {
  it("is read from the environment in exactly one module", () => {
    const readers = PRODUCTION.filter((f) =>
      f.text.includes("import.meta.env.VITE_GOOGLE_MAPS_KEY"),
    ).map((f) => f.path);
    expect(readers).toEqual(["lib/config.ts"]);
  });

  it("is never interpolated into a string anywhere", () => {
    // Template interpolation and concatenation are the two ways a value gets
    // into human-readable text. Neither may carry this one.
    for (const file of PRODUCTION) {
      expect(file.text, file.path).not.toMatch(/\$\{\s*(apiKey|key)\s*[}.]/);
      expect(file.text, file.path).not.toMatch(/["'`]\s*\+\s*(apiKey|key)\b/);
      expect(file.text, file.path).not.toMatch(/\b(apiKey|key)\s*\+\s*["'`]/);
    }
  });

  it("is passed to the provider as a value, never spliced into a URL", () => {
    const renderer = PRODUCTION.find((f) => f.path === "viewer/tileRenderer.ts");
    expect(renderer).toBeDefined();
    // Cesium builds the request URL; we hand it the key as a field. A literal
    // "key=" in our own source would mean we were building the URL instead.
    expect(renderer!.text).toContain("{ key: apiKey }");
    expect(renderer!.text).not.toMatch(/["'`][^"'`\n]*[?&]key=\$/);
  });

  it("logs provider text only after it has been through the redactor", () => {
    // The viewer is the only half of the app that ever holds provider text.
    // Every console call there that carries a value — as opposed to logging a
    // fixed sentence — has to have redacted it, either inline, or through a
    // `detail` bound from describeError, or as a RenderFailure.detail (which
    // renderSession builds the same way).
    const viewer = PRODUCTION.filter((f) => f.path.startsWith("viewer/"));
    expect(viewer.length).toBeGreaterThan(0);
    for (const file of viewer) {
      const calls = file.text.match(/console\.(error|warn|log)\([\s\S]*?\);/g) ?? [];
      for (const call of calls) {
        const withoutStrings = call
          .replace(/^console\.\w+\(/, "")
          .replace(/(["'`])(?:\\.|(?!\1).)*\1/gs, "");
        if (!/[A-Za-z_$]/.test(withoutStrings)) continue; // fixed sentence only
        const inline = /describeError\(|redactKey\(|\.detail\b/.test(call);
        const viaBinding =
          /\bdetail\b/.test(call) &&
          /const\s+detail\s*=\s*describeError\(/.test(file.text);
        expect(
          inline || viaBinding,
          `${file.path}: unredacted console argument in ${call.slice(0, 90)}`,
        ).toBe(true);
      }
    }
  });

  it("turns a caught value into text in exactly one way", () => {
    // `String(err)`, `err.message` and `JSON.stringify(err)` all produce text
    // that can contain the failing request URL, and the key rides in that URL.
    for (const file of PRODUCTION.filter((f) => f.path.startsWith("viewer/"))) {
      for (const line of file.text.split("\n")) {
        if (!/\.message\b|\bString\(|JSON\.stringify\(/.test(line)) continue;
        expect(line.trim(), file.path).toMatch(/describeError\(|redactKey\(/);
      }
    }
  });

  it("is never named in a string a visitor could read", () => {
    for (const file of PRODUCTION) {
      expect(file.text, file.path).not.toMatch(/AIza[0-9A-Za-z_-]{10,}/);
    }
  });
});

describe("the app never asks the browser where the visitor is", () => {
  it("references no geolocation or permissions API", () => {
    for (const file of PRODUCTION) {
      expect(file.text, file.path).not.toMatch(/navigator\s*\.\s*geolocation/);
      expect(file.text, file.path).not.toMatch(/getCurrentPosition|watchPosition/);
      expect(file.text, file.path).not.toMatch(/navigator\s*\.\s*permissions/);
    }
  });

  it("asks for the location it needs by typing an address instead", () => {
    // The positive half of the same claim: the only way a coordinate enters
    // this app is a geocoded address the visitor typed.
    const geocode = PRODUCTION.find((f) => f.path === "lib/geocode.ts");
    expect(geocode).toBeDefined();
    expect(geocode!.text).toMatch(/geosearch\.planninglabs\.nyc/);
  });
});
