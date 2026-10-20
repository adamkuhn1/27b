import { afterEach, describe, expect, it, vi } from "vitest";
import { planView } from "./api";

const NETWORK_ERROR = {
  ok: false,
  reason: "network-error",
  message: "Something went wrong resolving this address. Please try again.",
};

function stubFetch(impl: (...args: Parameters<typeof fetch>) => Promise<Response>) {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("planView", () => {
  it("returns network-error when the backend is unreachable", async () => {
    // What fetch does on connection refused / DNS failure.
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(planView("11 Wall St", 12)).resolves.toEqual(NETWORK_ERROR);
  });

  it("returns network-error when a 200 body isn't JSON", async () => {
    stubFetch(() => Promise.resolve(new Response("<html>Bad Gateway</html>", { status: 200 })));
    await expect(planView("11 Wall St", 12)).resolves.toEqual(NETWORK_ERROR);
  });

  it("returns network-error on a non-200 response", async () => {
    stubFetch(() => Promise.resolve(new Response("oops", { status: 500 })));
    await expect(planView("11 Wall St", 12)).resolves.toEqual(NETWORK_ERROR);
  });

  it("still rejects when the request is aborted", async () => {
    const controller = new AbortController();
    stubFetch((_url, init) => {
      controller.abort();
      return Promise.reject(init?.signal?.reason);
    });
    await expect(planView("11 Wall St", 12, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("returns the plan on success", async () => {
    // planView doesn't inspect the plan, so a stand-in object is enough.
    const plan = { views: [] };
    stubFetch(() => Promise.resolve(Response.json({ ok: true, plan })));
    await expect(planView("11 Wall St", 12)).resolves.toEqual({ ok: true, plan });
  });

  it("passes a backend unavailable result through", async () => {
    const body = { ok: false, reason: "not-supported", message: "Not yet." };
    const mock = stubFetch(() => Promise.resolve(Response.json(body)));
    await expect(planView("11 Wall St", 12)).resolves.toEqual({ ...body, supportedFloors: undefined });
    expect(mock).toHaveBeenCalledWith(
      "/api/view-plan",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ address: "11 Wall St", floor: 12 }) }),
    );
  });
});
