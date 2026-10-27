import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { assembleChatBody, ensureSession, runChat } from "../src/sessions.ts";
import { expectMetadataShape } from "./metadata-shape.ts";

// The session/run error paths, driven against one configurable loopback stub. Every
// test uses its own account id so the module's per-account session map never
// leaks between them, and gapMs 0 unless the debounce itself is the subject.

interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | null;
  instanceHeader: string | null;
  modelHeader: string | null;
  body: any;
  at: number;
}

interface StubRoutes {
  createSession?: () => Response;
  getSession?: (instanceId: string | null) => Response;
  deleteSession?: () => Response;
  agentRun?: (body: any) => Response | Promise<Response>;
  chat?: (body: any) => Response;
}

const TOKEN = "fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7";
const MODEL = "minimax/minimax-m2.7";
const ACTIVE_SESSION = {
  status: "active",
  instanceId: "inst-1",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  remainingMs: 3_600_000,
  model: MODEL,
};

describe("sessions and runs", () => {
  let recorded: RecordedRequest[] = [];
  let routes: StubRoutes = {};
  let stop = () => {};

  beforeAll(async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const body = req.method === "POST" ? await req.json().catch(() => null) : null;
        recorded.push({
          method: req.method,
          path: url.pathname,
          authorization: req.headers.get("authorization"),
          instanceHeader: req.headers.get("x-freebuff-instance-id"),
          modelHeader: req.headers.get("x-freebuff-model"),
          body,
          at: Date.now(),
        });
        if (url.pathname === "/api/v1/freebuff/session") {
          if (req.method === "POST") return routes.createSession?.() ?? Response.json(ACTIVE_SESSION);
          if (req.method === "GET") return routes.getSession?.(req.headers.get("x-freebuff-instance-id")) ?? Response.json(ACTIVE_SESSION);
          if (req.method === "DELETE") return routes.deleteSession?.() ?? new Response(null, { status: 204 });
        }
        if (url.pathname === "/api/v1/agent-runs" && req.method === "POST") return await (routes.agentRun?.(body) ?? Response.json({ runId: "run-1" }));
        if (url.pathname === "/api/v1/chat/completions" && req.method === "POST") return routes.chat?.(body) ?? Response.json({ ok: true });
        return new Response("stub: not found", { status: 404 });
      },
    });
    stop = () => server.stop(true);
    process.env.FREEBUFF_UPSTREAM_BASE_URL = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    stop();
    delete process.env.FREEBUFF_UPSTREAM_BASE_URL;
  });

  const chatOnce = (accountId: string, gapMs = 0, model = MODEL) =>
    runChat({
      accountId,
      token: TOKEN,
      model,
      body: { model, messages: [{ role: "user", content: "hi" }], stream: false },
      gapMs,
    });

  test("a sessionless account (404) chats without freebuff_instance_id, metadata exact", async () => {
    recorded = [];
    routes = { createSession: () => new Response("no session", { status: 404 }) };
    const attempt = await chatOnce("acct-sessionless");
    expect(attempt.response.status).toBe(200);
    const chat = recorded.find((r) => r.path === "/api/v1/chat/completions");
    expect(chat).toBeDefined();
    expectMetadataShape(chat!.body.codebuff_metadata, "run-1", null);
    expect(chat!.body.stop).toEqual(["cb_easp"]);
    expect(chat!.body.provider).toEqual({ data_collection: "deny" });
  });

  test("a live session is created once and reused; the chat body dials the canonical id", async () => {
    recorded = [];
    routes = {};
    await chatOnce("acct-reuse");
    await chatOnce("acct-reuse", 0, "minimax-m2.7");
    const creates = recorded.filter((r) => r.method === "POST" && r.path === "/api/v1/freebuff/session");
    expect(creates.length).toBe(1);
    expect(creates[0]!.modelHeader).toBe(MODEL);
    expect(creates[0]!.body).toEqual({});
    const chats = recorded.filter((r) => r.path === "/api/v1/chat/completions");
    expect(chats.length).toBe(2);
    expect(chats[0]!.body.model).toBe(MODEL);
    expect(chats[1]!.body.model).toBe(MODEL);
    expectMetadataShape(chats[0]!.body.codebuff_metadata, "run-1", "inst-1");
    const starts = recorded.filter((r) => r.path === "/api/v1/agent-runs" && r.body.action === "START");
    expect(starts.length).toBe(2);
    expect(starts[0]!.body).toEqual({ action: "START", agentId: "base2-free", ancestorRunIds: [] });
  });

  test("a queued session is polled until active, not cached queued", async () => {
    recorded = [];
    let polls = 0;
    routes = {
      createSession: () => Response.json({ ...ACTIVE_SESSION, status: "queued", estimatedWaitMs: 0 }),
      getSession: () => {
        polls += 1;
        return polls === 1 ? Response.json({ ...ACTIVE_SESSION, status: "queued" }) : Response.json(ACTIVE_SESSION);
      },
    };
    const entry = await ensureSession("acct-queued", TOKEN, MODEL);
    expect(entry?.instanceId).toBe("inst-1");
    const gets = recorded.filter((r) => r.method === "GET" && r.path === "/api/v1/freebuff/session");
    expect(gets.length).toBe(2);
    expect(gets[0]!.instanceHeader).toBe("inst-1");
    expect(gets[1]!.instanceHeader).toBe("inst-1");
  });

  test("a queue that closes (ended) gets one invalidation and recreate", async () => {
    recorded = [];
    let polls = 0;
    let recreated = false;
    routes = {
      createSession: () => {
        if (recreated) return Response.json(ACTIVE_SESSION);
        return Response.json({ ...ACTIVE_SESSION, status: "queued", estimatedWaitMs: 0 });
      },
      getSession: () => {
        polls += 1;
        return polls === 1 ? Response.json({ ...ACTIVE_SESSION, status: "queued" }) : Response.json({ ...ACTIVE_SESSION, status: "ended" });
      },
      deleteSession: () => {
        recreated = true;
        return new Response(null, { status: 204 });
      },
    };
    const entry = await ensureSession("acct-queue-ended", TOKEN, MODEL);
    expect(entry?.instanceId).toBe("inst-1");
    expect(recorded.some((r) => r.method === "DELETE" && r.path === "/api/v1/freebuff/session")).toBe(true);
  });

  test("model_locked on create ends the held session and recreates for the requested model", async () => {
    recorded = [];
    let locked = true;
    routes = {
      createSession: () => (locked ? Response.json({ error: "model_locked", currentModel: "minimax/minimax-m3" }, { status: 409 }) : Response.json(ACTIVE_SESSION)),
      deleteSession: () => {
        locked = false;
        return new Response(null, { status: 204 });
      },
    };
    const entry = await ensureSession("acct-locked", TOKEN, MODEL);
    expect(entry?.instanceId).toBe("inst-1");
    const methods = recorded.map((r) => `${r.method} ${r.path}`);
    expect(methods).toEqual(["POST /api/v1/freebuff/session", "DELETE /api/v1/freebuff/session", "POST /api/v1/freebuff/session"]);
    expect(recorded.every((r) => r.modelHeader !== "minimax/minimax-m3")).toBe(true);
  });

  test("a 426 chat invalidates the session and retries once", async () => {
    recorded = [];
    let firstChat = true;
    routes = {
      chat: () => {
        if (firstChat) {
          firstChat = false;
          return Response.json({ error: "freebuff_update_required" }, { status: 426 });
        }
        return Response.json({ ok: true });
      },
    };
    const attempt = await chatOnce("acct-426");
    expect(attempt.response.status).toBe(200);
    const methods = recorded.map((r) => `${r.method} ${r.path}`);
    expect(methods).toEqual([
      "POST /api/v1/freebuff/session",
      "POST /api/v1/agent-runs",
      "POST /api/v1/chat/completions",
      "DELETE /api/v1/freebuff/session",
      "POST /api/v1/freebuff/session",
      "POST /api/v1/agent-runs",
      "POST /api/v1/chat/completions",
    ]);
  });

  test("a lost run re-STARTs and retries the chat once", async () => {
    recorded = [];
    let firstChat = true;
    routes = {
      chat: () => {
        if (firstChat) {
          firstChat = false;
          return Response.json({ error: { message: "Error 400: runid not found" } }, { status: 400 });
        }
        return Response.json({ ok: true });
      },
    };
    const attempt = await chatOnce("acct-runid");
    expect(attempt.response.status).toBe(200);
    const starts = recorded.filter((r) => r.path === "/api/v1/agent-runs" && r.body.action === "START");
    expect(starts.length).toBe(2);
    expect(recorded.filter((r) => r.path === "/api/v1/chat/completions").length).toBe(2);
  });

  test("a session_model_mismatch chat invalidates, recreates, and retries once", async () => {
    recorded = [];
    let firstChat = true;
    routes = {
      chat: () => {
        if (firstChat) {
          firstChat = false;
          return Response.json(
            { error: { type: "session_model_mismatch", message: "session bound to minimax/minimax-m3", lockedModel: "minimax/minimax-m3" } },
            { status: 400 },
          );
        }
        return Response.json({ ok: true });
      },
    };
    const attempt = await chatOnce("acct-mismatch");
    expect(attempt.response.status).toBe(200);
    const methods = recorded.map((r) => `${r.method} ${r.path}`);
    expect(methods).toEqual([
      "POST /api/v1/freebuff/session",
      "POST /api/v1/agent-runs",
      "POST /api/v1/chat/completions",
      "DELETE /api/v1/freebuff/session",
      "POST /api/v1/freebuff/session",
      "POST /api/v1/agent-runs",
      "POST /api/v1/chat/completions",
    ]);
    expect(recorded.every((r) => r.modelHeader !== "minimax/minimax-m3")).toBe(true);
  });

  test("a mismatch that survives the retry fails with both models named", async () => {
    recorded = [];
    routes = {
      chat: () =>
        Response.json(
          { error: { type: "session_model_mismatch", message: "session bound to minimax/minimax-m3", lockedModel: "minimax/minimax-m3" } },
          { status: 400 },
        ),
    };
    let thrown: unknown = null;
    try {
      await chatOnce("acct-mismatch-persist");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("minimax/minimax-m3");
    expect((thrown as Error).message).toContain("minimax/minimax-m2.7");
    expect(recorded.filter((r) => r.path === "/api/v1/chat/completions").length).toBe(2);
  });

  test("an alias dials the canonical id on the session create and the chat body", async () => {
    recorded = [];
    routes = {};
    const attempt = await chatOnce("acct-alias", 0, "minimax-m2.7");
    expect(attempt.response.status).toBe(200);
    const create = recorded.find((r) => r.method === "POST" && r.path === "/api/v1/freebuff/session");
    expect(create!.modelHeader).toBe(MODEL);
    const chat = recorded.find((r) => r.path === "/api/v1/chat/completions");
    expect(chat!.body.model).toBe(MODEL);
  });

  test("a passthrough error body is rebuilt without the old framing headers", async () => {
    recorded = [];
    routes = {
      // 7 bytes of body, declared 7: a real content-length the rebuild must drop
      chat: () => new Response('{"e":1}', {
        status: 404,
        headers: { "content-type": "application/json", "content-length": "7" },
      }),
    };
    const attempt = await chatOnce("acct-rebuild");
    expect(attempt.response.status).toBe(404);
    expect(attempt.response.headers.get("content-length")).toBeNull();
    expect(attempt.response.headers.get("content-encoding")).toBeNull();
    expect(attempt.response.headers.get("transfer-encoding")).toBeNull();
  });

  test("two concurrent cold chats land their POSTs ≥ gap apart even when the first builds a session", async () => {
    recorded = [];
    let starts = 0;
    routes = {
      // the first chat's run START lags 600 ms: its session caches long before
      // its dial, so the second chat rides the cache and its POST lands while
      // the first is still between setup and dial
      agentRun: (body) => {
        starts += 1;
        if (body.action === "START" && starts === 1) {
          return new Promise((resolve) => setTimeout(() => resolve(Response.json({ runId: "run-1" })), 600));
        }
        return Response.json({ runId: "run-1" });
      },
    };
    const first = chatOnce("acct-gap-cold", 150);
    await Bun.sleep(500);
    const second = chatOnce("acct-gap-cold", 150);
    await Promise.all([first, second]);
    const chats = recorded.filter((r) => r.path === "/api/v1/chat/completions");
    expect(chats.length).toBe(2);
    expect(Math.abs(chats[0]!.at - chats[1]!.at)).toBeGreaterThanOrEqual(140);
  });

  test("a queued session's poll never holds the dial gate", async () => {
    recorded = [];
    let firstCreate = true;
    routes = {
      createSession: () => {
        if (firstCreate) {
          firstCreate = false;
          return Response.json({ ...ACTIVE_SESSION, status: "queued", estimatedWaitMs: 1200 });
        }
        return Response.json(ACTIVE_SESSION);
      },
    };
    const started = Date.now();
    const first = chatOnce("acct-gap-queued", 150);
    await Bun.sleep(50);
    const second = chatOnce("acct-gap-queued", 150);
    await Promise.all([first, second]);
    const chats = recorded.filter((r) => r.path === "/api/v1/chat/completions");
    expect(chats.length).toBe(2);
    // the first chat cannot dial before its ~1200 ms poll settles, so an early
    // POST is the second chat's: the poll never blocked it
    expect(chats[0]!.at).toBeLessThan(started + 1200);
  });

  test("FINISH closes the run with the completed shape", async () => {
    recorded = [];
    routes = {};
    const attempt = await chatOnce("acct-finish");
    await attempt.finish();
    const finishes = recorded.filter((r) => r.path === "/api/v1/agent-runs" && r.body.action === "FINISH");
    expect(finishes.length).toBe(1);
    expect(finishes[0]!.body).toEqual({ action: "FINISH", runId: "run-1", status: "completed", totalSteps: 0, directCredits: 0, totalCredits: 0 });
  });

  test("the request gap spaces an account's chats, concurrent chats included", async () => {
    recorded = [];
    routes = {};
    await chatOnce("acct-gap-seq");
    const started = Date.now();
    await chatOnce("acct-gap-seq", 150);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);

    recorded = [];
    await chatOnce("acct-gap-concurrent", 150);
    const first = chatOnce("acct-gap-concurrent", 150);
    const second = chatOnce("acct-gap-concurrent", 150);
    await Promise.all([first, second]);
    const chats = recorded.filter((r) => r.path === "/api/v1/chat/completions");
    expect(chats.length).toBe(3);
    expect(chats[2]!.at - chats[1]!.at).toBeGreaterThanOrEqual(140);

    const { requestGapMs, DEFAULT_REQUEST_GAP_MS } = await import("../src/sessions.ts");
    expect(DEFAULT_REQUEST_GAP_MS).toBe(1300);
    expect(requestGapMs({})).toBe(1300);
    expect(requestGapMs({ request_gap_ms: 250 })).toBe(250);
    expect(requestGapMs({ request_gap_ms: -5 })).toBe(1300);
    expect(requestGapMs({ request_gap_ms: "250" })).toBe(1300);
  });
});

describe("chat body assembly", () => {
  test("the client's stop wins over the cb_easp default; the session id rides only when it exists", () => {
    const session = { instanceId: "inst-9", model: "m", expiresAtEpoch: Number.MAX_SAFE_INTEGER };
    const withStop = assembleChatBody({ model: "m", stop: ["END"] }, "run-1", session);
    expect(withStop.stop).toEqual(["END"]);
    expectMetadataShape(withStop.codebuff_metadata as Record<string, unknown>, "run-1", "inst-9");
    const sessionless = assembleChatBody({ model: "m" }, "run-2", null);
    expect(sessionless.stop).toEqual(["cb_easp"]);
    expectMetadataShape(sessionless.codebuff_metadata as Record<string, unknown>, "run-2", null);
    expect(sessionless.provider).toEqual({ data_collection: "deny" });
  });
});
