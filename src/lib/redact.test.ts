import { describe, it, expect } from "vitest";
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
