import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ConvertError } from "../src/convert.ts";
import { assembleChatBody, catalogueOf, dropCatalogue, endAccountSessions, instanceIdOf, runChat } from "../src/sessions.ts";

// The sessionless chat chain, the per-account catalogue cache and the locally
// minted instance id, driven against one configurable loopback stub. Every
// test uses its own account id so the module's per-account state never leaks
// between them, and gapMs 0 unless the debounce itself is the subject.

interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | null;
  instanceHeader: string | null;
  catalogHeader: string | null;
  body: any;
  at: number;
}

interface StubRoutes {
  models?: () => Response;
  deleteSession?: () => Response;
  agentRun?: (body: any) => Response | Promise<Response>;
  chat?: (body: any) => Response;
}

const TOKEN = "fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7";
const KEY = "m-0000000001";
const HANDLE = "fbm1.sessions";
const CLIENT_ID_RE = /^[0-9a-z]{10}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLI_INSTANCE_RE = /^cli:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CATALOGUE_BODY = {
  version: "v0.test.1",
  rows: [{ key: KEY, handle: HANDLE, displayName: "MiMo v2.6 Flash Slow", access: "open", dataUse: "service", premium: false }],
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
          catalogHeader: req.headers.get("x-freebuff-catalog-protocol"),
          body,
          at: Date.now(),
        });
        if (url.pathname === "/api/v1/freebuff/models" && req.method === "GET") {
          return routes.models?.() ?? Response.json(CATALOGUE_BODY);
        }
        if (url.pathname === "/api/v1/freebuff/session" && req.method === "DELETE") {
          return routes.deleteSession?.() ?? new Response(null, { status: 204 });
        }
        if (url.pathname === "/api/v1/agent-runs" && req.method === "POST") {
          return await (routes.agentRun?.(body) ?? Response.json({ runId: "run-1" }));
        }
        if (url.pathname === "/api/v1/chat/completions" && req.method === "POST") {
          return routes.chat?.(body) ?? Response.json({ ok: true });
        }
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

  const chatOnce = (accountId: string, gapMs = 0) =>
    runChat({
      accountId,
      token: TOKEN,
      model: KEY,
      handle: HANDLE,
      body: { model: HANDLE, messages: [{ role: "user", content: "hi" }], stream: false },
      gapMs,
    });

  test("a chat is sessionless: START on the free-catalog agent, the cli: instance id rides the metadata", async () => {
    recorded = [];
    routes = {};
    const attempt = await chatOnce("acct-shape");
    expect(attempt.response.status).toBe(200);
    expect(recorded.some((r) => r.path === "/api/v1/freebuff/session")).toBe(false);
    const starts = recorded.filter((r) => r.path === "/api/v1/agent-runs" && r.body.action === "START");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.body).toEqual({ action: "START", agentId: "base3-free-catalog", ancestorRunIds: [] });
    const chat = recorded.find((r) => r.path === "/api/v1/chat/completions");
    expect(chat).toBeDefined();
    expect(chat!.body.model).toBe(HANDLE);
    expect(chat!.body.stop).toBeUndefined();
    expect(chat!.body.provider).toEqual({ data_collection: "deny" });
    const meta = chat!.body.codebuff_metadata as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual([
      "client_id",
      "cost_mode",
      "freebuff_client_env",
      "freebuff_input_profile",
      "freebuff_instance_id",
      "freebuff_multi_session",
      "llm_step_number",
      "repo_snapshot",
      "run_id",
      "surface",
      "trace_session_id",
    ]);
    expect(meta.cost_mode).toBe("free");
    expect(meta.run_id).toBe("run-1");
    expect(meta.freebuff_multi_session).toBe("1");
    expect(meta.surface).toBe("cli");
    expect(meta.llm_step_number).toBe("1");
    expect(meta.client_id).toMatch(CLIENT_ID_RE);
    expect(meta.trace_session_id).toMatch(UUID_RE);
    expect(meta.freebuff_instance_id).toMatch(CLI_INSTANCE_RE);
    expect(String(meta.freebuff_client_env)).toMatch(/^v1;/);
    expect(String(meta.freebuff_input_profile)).toMatch(/^v1;/);
    expect(String(meta.repo_snapshot)).toMatch(/^\{/);
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
    expect(starts).toHaveLength(2);
    expect(recorded.filter((r) => r.path === "/api/v1/chat/completions")).toHaveLength(2);
  });

  test("a session_model_mismatch chat ends the server session once and retries", async () => {
    recorded = [];
    let firstChat = true;
    routes = {
      chat: () => {
        if (firstChat) {
          firstChat = false;
          return Response.json(
            { error: { type: "session_model_mismatch", message: "session bound to minimax/minimax-m3", lockedModel: "minimax/minimax-m3" } },
            { status: 409 },
          );
        }
        return Response.json({ ok: true });
      },
    };
    const attempt = await chatOnce("acct-mismatch");
    expect(attempt.response.status).toBe(200);
    const methods = recorded.map((r) => `${r.method} ${r.path}`);
    expect(methods).toEqual([
      "POST /api/v1/agent-runs",
      "POST /api/v1/chat/completions",
      "DELETE /api/v1/freebuff/session",
      "POST /api/v1/agent-runs",
      "POST /api/v1/chat/completions",
    ]);
    const del = recorded.find((r) => r.method === "DELETE");
    expect(del!.instanceHeader).toMatch(CLI_INSTANCE_RE);
  });

  test("a mismatch that survives the retry fails with both models named", async () => {
    recorded = [];
    routes = {
      chat: () =>
        Response.json(
          { error: { type: "session_model_mismatch", message: "session bound to minimax/minimax-m3", lockedModel: "minimax/minimax-m3" } },
          { status: 409 },
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
    expect((thrown as Error).message).toContain(KEY);
    expect(recorded.filter((r) => r.path === "/api/v1/chat/completions")).toHaveLength(2);
  });

  test("a freebuff_catalog_stale chat refetches the catalogue once and retries with the fresh handle", async () => {
    recorded = [];
    let firstChat = true;
    routes = {
      chat: () => {
        if (firstChat) {
          firstChat = false;
          return Response.json({ error: "freebuff_catalog_stale" }, { status: 409 });
        }
        return Response.json({ ok: true });
      },
      models: () =>
        Response.json({
          version: "v0.test.2",
          rows: [{ key: KEY, handle: "fbm1.fresh", displayName: "MiMo v2.6 Flash Slow", access: "open", dataUse: "service", premium: false }],
        }),
    };
    const attempt = await chatOnce("acct-stale");
    expect(attempt.response.status).toBe(200);
    const methods = recorded.map((r) => `${r.method} ${r.path}`);
    expect(methods).toEqual([
      "POST /api/v1/agent-runs",
      "POST /api/v1/chat/completions",
      "GET /api/v1/freebuff/models",
      "POST /api/v1/agent-runs",
      "POST /api/v1/chat/completions",
    ]);
    const gets = recorded.filter((r) => r.path === "/api/v1/freebuff/models");
    expect(gets).toHaveLength(1);
    expect(gets[0]!.catalogHeader).toBe("1");
    const chats = recorded.filter((r) => r.path === "/api/v1/chat/completions");
    expect(chats[0]!.body.model).toBe(HANDLE);
    expect(chats[1]!.body.model).toBe("fbm1.fresh");
  });

  test("a catalogue that stays stale after the refetch fails", async () => {
    recorded = [];
    routes = { chat: () => Response.json({ error: "freebuff_catalog_stale" }, { status: 409 }) };
    let thrown: unknown = null;
    try {
      await chatOnce("acct-stale-persist");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("freebuff_catalog_stale");
    expect(recorded.filter((r) => r.path === "/api/v1/chat/completions")).toHaveLength(2);
  });

  test("a refetched catalogue that dropped the row is an unknown model", async () => {
    routes = {
      chat: () => Response.json({ error: "freebuff_catalog_stale" }, { status: 409 }),
      models: () =>
        Response.json({
          version: "v0.test.2",
          rows: [{ key: "m-other", handle: "fbm1.other", displayName: "Other", access: "open", dataUse: "service", premium: false }],
        }),
    };
    await expect(chatOnce("acct-stale-gone")).rejects.toThrow(ConvertError);
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

  test("two concurrent cold chats land their POSTs ≥ gap apart even when the first's run START lags", async () => {
    recorded = [];
    let starts = 0;
    routes = {
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

  test("the catalogue is fetched once per account and cached; dropCatalogue forces a refetch", async () => {
    recorded = [];
    routes = {};
    await catalogueOf("acct-cache", TOKEN);
    await catalogueOf("acct-cache", TOKEN);
    expect(recorded.filter((r) => r.path === "/api/v1/freebuff/models")).toHaveLength(1);
    dropCatalogue("acct-cache");
    await catalogueOf("acct-cache", TOKEN);
    expect(recorded.filter((r) => r.path === "/api/v1/freebuff/models")).toHaveLength(2);
    expect(recorded.every((r) => r.catalogHeader === "1")).toBe(true);
  });

  test("a 401 catalogue is login_required; an answer without rows is upstream trouble", async () => {
    routes = { models: () => new Response(JSON.stringify({ error: "Invalid API key or user not found" }), { status: 401 }) };
    let thrown: unknown = null;
    try {
      await catalogueOf("acct-401", TOKEN);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("catalogue");
    expect((thrown as Error).message).toContain("401");

    routes = { models: () => Response.json({ version: "v1" }) };
    await expect(catalogueOf("acct-no-rows", TOKEN)).rejects.toThrow("no rows");
  });

  test("each account mints one stable cli: instance id; different accounts differ", () => {
    expect(instanceIdOf("acct-id-a")).toBe(instanceIdOf("acct-id-a"));
    expect(instanceIdOf("acct-id-a")).toMatch(CLI_INSTANCE_RE);
    expect(instanceIdOf("acct-id-b")).not.toBe(instanceIdOf("acct-id-a"));
  });

  test("endAccountSessions deletes the session with the account's instance id", async () => {
    recorded = [];
    routes = {};
    await endAccountSessions("acct-end", TOKEN);
    const dels = recorded.filter((r) => r.method === "DELETE" && r.path === "/api/v1/freebuff/session");
    expect(dels).toHaveLength(1);
    expect(dels[0]!.instanceHeader).toMatch(CLI_INSTANCE_RE);
  });
});

describe("chat body assembly", () => {
  test("the measured CLI fields ride; a client stop survives and none is invented", () => {
    const body = assembleChatBody({ model: "m", stop: ["END"] }, "run-1", "cli:11111111-2222-4333-8444-555555555555", "ff7xdk3ftw");
    expect(body.stop).toEqual(["END"]);
    const meta = body.codebuff_metadata as Record<string, unknown>;
    expect(meta.freebuff_instance_id).toBe("cli:11111111-2222-4333-8444-555555555555");
    expect(meta.freebuff_multi_session).toBe("1");
    expect(meta.surface).toBe("cli");
    expect(meta.cost_mode).toBe("free");
    expect(meta.llm_step_number).toBe("1");
    expect(meta.run_id).toBe("run-1");
    expect(meta.client_id).toMatch(CLIENT_ID_RE);
    expect(meta.trace_session_id).toMatch(UUID_RE);
    expect(meta.freebuff_client_env).toBe(
      "v1;in=1;out=1;tp=tmux;term=1;ct=1;sz=220x50;ci=0;ssh=0;l=0;p=shell;g=mux;osc=1;tzo=0;px=none;tls=1;ca=0;cde=none",
    );
    expect(meta.freebuff_input_profile).toBe("v1;tc=0;ke=0;mc=0;pc=0;pe=0;cps=0");
    expect(meta.repo_snapshot).toBe(
      '{"gitAvailable":true,"repositoryVisibility":"unknown","fileCount":1,"fileCountIsLowerBound":false,"testFileCount":0,"historyIsShallow":false,"changedFileCount":0,"changedFileScanTruncated":false}',
    );
    expect(body.provider).toEqual({ data_collection: "deny" });
    const plain = assembleChatBody({ model: "m" }, "run-2", "cli:11111111-2222-4333-8444-555555555555", "ff7xdk3ftw");
    expect("stop" in plain).toBe(false);
  });
});
