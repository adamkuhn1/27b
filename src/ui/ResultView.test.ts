import { describe, expect, it } from "vitest";
import { renderProgress } from "./ResultView";
import type { ViewSlot, ViewState } from "../lib/types";

const SLOTS: ViewSlot[] = ["V1", "V2", "V3", "V4"];

const pending: ViewState = { kind: "pending" };
const capturing: ViewState = { kind: "capturing" };
const ready: ViewState = {
  kind: "ready",
  result: { slot: "V1", dataUrl: "data:image/png;base64,", attribution: [] },
};
const failed: ViewState = { kind: "failed", detail: "empty frame" };

function states(v1: ViewState, v2: ViewState, v3: ViewState, v4: ViewState) {
  return { V1: v1, V2: v2, V3: v3, V4: v4 };
}

describe("renderProgress", () => {
  it("starts at 0 of 4", () => {
    expect(renderProgress(SLOTS, states(pending, pending, pending, pending))).toEqual({
      done: 0,
      failed: 0,
      total: 4,
      label: "Rendering… 0 of 4 views ready",
    });
  });

  it("does not count the view being captured as ready", () => {
    expect(
      renderProgress(SLOTS, states(capturing, pending, pending, pending)).done,
    ).toBe(0);
  });

  it("counts views as they land", () => {
    expect(renderProgress(SLOTS, states(ready, ready, capturing, pending))).toEqual({
      done: 2,
      failed: 0,
      total: 4,
      label: "Rendering… 2 of 4 views ready",
    });
  });

  it("counts a failed view as done but never as ready", () => {
    expect(renderProgress(SLOTS, states(ready, failed, capturing, pending))).toEqual({
      done: 2,
      failed: 1,
      total: 4,
      label: "Rendering… 1 of 4 views ready · 1 didn't load",
    });
  });

  it("has nothing to say once every view rendered", () => {
    expect(renderProgress(SLOTS, states(ready, ready, ready, ready)).label).toBeNull();
  });

  it("keeps a final summary when a view failed", () => {
    expect(renderProgress(SLOTS, states(ready, failed, ready, failed))).toEqual({
      done: 4,
      failed: 2,
      total: 4,
      label: "2 of 4 views rendered · 2 didn't load",
    });
  });

  it("reports a whole-session failure honestly", () => {
    expect(renderProgress(SLOTS, states(failed, failed, failed, failed)).label).toBe(
      "0 of 4 views rendered · 4 didn't load",
    );
  });

  it("counts only the plan's slots", () => {
    expect(
      renderProgress(["V1", "V2"], states(ready, pending, ready, ready)),
    ).toMatchObject({ done: 1, total: 2 });
  });
});
