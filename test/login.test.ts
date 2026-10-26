import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loginPaste, loginPoll, loginStart, maskedLabel } from "../src/login.ts";

// The three paste outcomes, probed against a loopback stub: 200 → done,
// 401 → code_invalid, an unreachable upstream → the error rethrows so the core
// flow stays pending. The env seam reads at each access, so the unreachable
// case just points the seam at a port nothing listens on.

const ORIGINAL_BASE = process.env.FREEBUFF_UPSTREAM_BASE_URL;

describe("paste login", () => {
  let recorded: Array<{ method: string; path: string; authorization: string | null }> = [];
  let port = 0;
  let stop = () => {};

  beforeAll(async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        recorded.push({ method: req.method, path: url.pathname, authorization: req.headers.get("authorization") });
        if (req.method === "GET" && url.pathname === "/api/v1/freebuff/streak") {
          if (req.headers.get("authorization") === "Bearer 00000000-0000-4000-8000-000000000000") {
            return new Response(null, { status: 401 });
          }
          return Response.json({ streakDays: 3 });
        }
        return new Response("stub: not found", { status: 404 });
      },
    });
    port = server.port ?? 0;
    stop = () => server.stop(true);
    process.env.FREEBUFF_UPSTREAM_BASE_URL = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    stop();
    if (ORIGINAL_BASE === undefined) delete process.env.FREEBUFF_UPSTREAM_BASE_URL;
    else process.env.FREEBUFF_UPSTREAM_BASE_URL = ORIGINAL_BASE;
  });

  test("loginStart opens the paste door with the documented url and ttl", async () => {
    const start = await loginStart({ accountId: null, existing: null });
    expect(start.url).toBe("https://freebuff.llm.pm");
    expect(start.modes).toEqual(["paste"]);
    expect(start.poll_interval_ms).toBe(2000);
    const ttl = Date.parse(start.expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(29 * 60_000);
    expect(ttl).toBeLessThanOrEqual(30 * 60_000);
    expect(await loginPoll({ accountId: null, existing: null, upstream: null })).toEqual({ state: "pending" });
  });

  test("a valid uuid probes the streak route and completes as the masked account", async () => {
    recorded = [];
    const done = await loginPaste({ accountId: null, existing: null, upstream: null, code: "fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7" });
    expect(done).toEqual({
      state: "done",
      identity: "fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7",
      label: "freebuff fa82…f6a7",
      plans: [{ id: "free", label: "Free" }],
      blob: "fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7",
    });
    expect(maskedLabel("fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7")).toBe("freebuff fa82…f6a7");
    expect(recorded).toEqual([{ method: "GET", path: "/api/v1/freebuff/streak", authorization: "Bearer fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7" }]);
  });

  test("a 401 probe fails the flow with code_invalid", async () => {
    const failed = await loginPaste({ accountId: null, existing: null, upstream: null, code: "00000000-0000-4000-8000-000000000000" });
    expect(failed).toEqual({ state: "failed", error: "code_invalid" });
  });

  test("a 404 probe (route disabled) fails the flow; a 5xx stays transient", async () => {
    let status = 404;
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("upstream trouble", { status }),
    });
    const previous = process.env.FREEBUFF_UPSTREAM_BASE_URL;
    try {
      process.env.FREEBUFF_UPSTREAM_BASE_URL = `http://127.0.0.1:${server.port}`;
      const failed = await loginPaste({ accountId: null, existing: null, upstream: null, code: "fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7" });
      expect(failed).toEqual({ state: "failed", error: "upstream_unavailable" });
      status = 500;
      let thrown: unknown = null;
      try {
        await loginPaste({ accountId: null, existing: null, upstream: null, code: "fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7" });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
    } finally {
      if (previous === undefined) delete process.env.FREEBUFF_UPSTREAM_BASE_URL;
      else process.env.FREEBUFF_UPSTREAM_BASE_URL = previous;
      server.stop(true);
    }
  });

  test("a non-uuid paste is code_invalid without touching the network", async () => {
    recorded = [];
    const failed = await loginPaste({ accountId: null, existing: null, upstream: null, code: "not-a-uuid" });
    expect(failed).toEqual({ state: "failed", error: "code_invalid" });
    expect(recorded).toEqual([]);
  });

  test("an unreachable upstream rethrows, leaving the flow pending", async () => {
    process.env.FREEBUFF_UPSTREAM_BASE_URL = "http://127.0.0.1:1";
    let thrown: unknown = null;
    try {
      await loginPaste({ accountId: null, existing: null, upstream: null, code: "fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    process.env.FREEBUFF_UPSTREAM_BASE_URL = `http://127.0.0.1:${port}`;
  });
});
