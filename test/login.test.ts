import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loginPaste, loginPoll, loginStart, maskedLabel, POLL_INTERVAL_MS } from "../src/login.ts";

// The browser door and the paste door against a loopback stub: the CLI's
// login-code route, its status poll (401 until a user signs in), and the
// streak probe both doors end on. The env seam reads at each access, so the
// unreachable case just points it at a port nothing listens on.

const ORIGINAL_BASE = process.env.FREEBUFF_UPSTREAM_BASE_URL;
const TOKEN = "fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7";
const HASH = "b".repeat(64);

describe("the login plane", () => {
  let recorded: Array<{ method: string; path: string; authorization: string | null; body: string | null }> = [];
  let loginUserToken: string | null = null;
  let issued: { fingerprintId: string; expiresAt: number } | null = null;
  let port = 0;
  let stop = () => {};

  beforeAll(async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const body = req.method === "GET" || req.method === "DELETE" ? null : await req.text();
        recorded.push({ method: req.method, path: url.pathname, authorization: req.headers.get("authorization"), body });
        if (req.method === "GET" && url.pathname === "/api/v1/freebuff/streak") {
          if (req.headers.get("authorization") === "Bearer 00000000-0000-4000-8000-000000000000") {
            return new Response(null, { status: 401 });
          }
          return Response.json({ streakDays: 3 });
        }
        if (req.method === "POST" && url.pathname === "/api/auth/cli/code") {
          const fingerprintId = (JSON.parse(body ?? "{}") as { fingerprintId?: string }).fingerprintId ?? "";
          issued = { fingerprintId, expiresAt: Date.now() + 600_000 };
          return Response.json({
            loginUrl: "https://www.codebuff.com/login?auth_code=stub",
            fingerprintId: "echoed",
            fingerprintHash: HASH,
            expiresAt: issued.expiresAt,
            expiresInMs: 600_000,
          });
        }
        if (req.method === "GET" && url.pathname === "/api/auth/cli/status") {
          // the poll must carry the code answer's own id, hash and expiry
          if (issued === null) return new Response(JSON.stringify({ error: "Authentication failed" }), { status: 401 });
          const query = url.searchParams;
          if (query.get("fingerprintId") !== issued.fingerprintId || query.get("fingerprintHash") !== HASH || query.get("expiresAt") !== String(issued.expiresAt)) {
            return new Response(JSON.stringify({ error: "Authentication failed" }), { status: 401 });
          }
          if (loginUserToken === null) return new Response(JSON.stringify({ error: "Authentication failed" }), { status: 401 });
          return Response.json({ user: { id: "user-1", email: "stub@example.com", name: "Stub", authToken: loginUserToken } });
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

  test("loginStart asks for a login code with no credential and returns the upstream URL", async () => {
    recorded = [];
    const start = await loginStart({ accountId: null, existing: null });

    expect(recorded).toHaveLength(1);
    const call = recorded[0]!;
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/auth/cli/code");
    expect(call.authorization).toBeNull();
    const fingerprintId = (JSON.parse(call.body ?? "{}") as { fingerprintId?: string }).fingerprintId;
    expect(fingerprintId?.startsWith("clauth-freebuff-proxy-")).toBe(true);

    expect(start.url).toBe("https://www.codebuff.com/login?auth_code=stub");
    expect(start.modes).toEqual(["poll", "paste"]);
    expect(start.poll_interval_ms).toBe(POLL_INTERVAL_MS);
    expect(Date.parse(start.expires_at)).toBeGreaterThan(Date.now());
    expect(start.upstream).toMatchObject({ fingerprintId, fingerprintHash: HASH });
  });

  test("loginPoll waits on 401 and completes with the upstream token once the user signs in", async () => {
    loginUserToken = null;
    recorded = [];
    const start = await loginStart({ accountId: null, existing: null });
    const pending = await loginPoll({ accountId: null, existing: null, upstream: start.upstream });
    expect(pending).toEqual({ state: "pending" });

    loginUserToken = TOKEN;
    const done = await loginPoll({ accountId: null, existing: null, upstream: start.upstream });
    expect(done).toEqual({
      state: "done",
      identity: TOKEN,
      label: "freebuff fa82…f6a7",
      plans: [{ id: "free", label: "Free" }],
      blob: TOKEN,
    });

    const statusCalls = recorded.filter((call) => call.path === "/api/auth/cli/status");
    expect(statusCalls).toHaveLength(2);
    expect(statusCalls[0]!.authorization).toBeNull();
    const probes = recorded.filter((call) => call.path === "/api/v1/freebuff/streak");
    expect(probes).toEqual([{ method: "GET", path: "/api/v1/freebuff/streak", authorization: `Bearer ${TOKEN}`, body: null }]);
  });

  test("a status answer carrying a non-uuid token fails the flow", async () => {
    loginUserToken = "not-a-uuid";
    const start = await loginStart({ accountId: null, existing: null });
    expect(await loginPoll({ accountId: null, existing: null, upstream: start.upstream })).toEqual({ state: "failed", error: "code_invalid" });
    loginUserToken = null;
  });

  test("a status token the streak route rejects fails the flow", async () => {
    loginUserToken = "00000000-0000-4000-8000-000000000000";
    const start = await loginStart({ accountId: null, existing: null });
    expect(await loginPoll({ accountId: null, existing: null, upstream: start.upstream })).toEqual({ state: "failed", error: "code_invalid" });
    loginUserToken = null;
  });

  test("a null handle polls as pending without a request", async () => {
    recorded = [];
    expect(await loginPoll({ accountId: null, existing: null, upstream: null })).toEqual({ state: "pending" });
    expect(recorded).toEqual([]);
  });

  test("a pasted uuid probes the streak route and completes as the masked account", async () => {
    recorded = [];
    const done = await loginPaste({ accountId: null, existing: null, upstream: null, code: TOKEN });
    expect(done).toEqual({
      state: "done",
      identity: TOKEN,
      label: "freebuff fa82…f6a7",
      plans: [{ id: "free", label: "Free" }],
      blob: TOKEN,
    });
    expect(maskedLabel(TOKEN)).toBe("freebuff fa82…f6a7");
    expect(recorded).toEqual([{ method: "GET", path: "/api/v1/freebuff/streak", authorization: `Bearer ${TOKEN}`, body: null }]);
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
      const failed = await loginPaste({ accountId: null, existing: null, upstream: null, code: TOKEN });
      expect(failed).toEqual({ state: "failed", error: "upstream_unavailable" });
      status = 500;
      let thrown: unknown = null;
      try {
        await loginPaste({ accountId: null, existing: null, upstream: null, code: TOKEN });
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
      await loginPaste({ accountId: null, existing: null, upstream: null, code: TOKEN });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    process.env.FREEBUFF_UPSTREAM_BASE_URL = `http://127.0.0.1:${port}`;
  });
});
