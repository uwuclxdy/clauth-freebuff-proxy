import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { expectMetadataShape } from "./metadata-shape.ts";

const REPO = join(import.meta.dir, "..");
const ADMIN_TOKEN = "0".repeat(64);
const PASTE_TOKEN = "fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7";

type RecordedRequest = {
  method: string;
  path: string;
  authorization: string | null;
  userAgent: string | null;
  instanceHeader: string | null;
  modelHeader: string | null;
  body: unknown;
};

function openaiChunk(delta: unknown, finishReason: string | null, usage?: unknown): string {
  return `data: ${JSON.stringify({ id: "chatcmpl-1", model: "minimax/minimax-m2.7", choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage === undefined ? {} : { usage }) })}\n\n`;
}

function makeStubUpstream(recorded: RecordedRequest[]): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === "GET" || req.method === "DELETE" ? null : await req.text();
      recorded.push({
        method: req.method,
        path: url.pathname,
        authorization: req.headers.get("authorization"),
        userAgent: req.headers.get("user-agent"),
        instanceHeader: req.headers.get("x-freebuff-instance-id"),
        modelHeader: req.headers.get("x-freebuff-model"),
        body: body === null ? null : JSON.parse(body),
      });
      if (req.method === "GET" && url.pathname === "/api/v1/freebuff/streak") {
        return Response.json({ streakDays: 3 });
      }
      if (req.method === "POST" && url.pathname === "/api/v1/agent-runs") {
        return Response.json({ runId: "run-1" });
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/v1/agent-runs/")) {
        return Response.json({ ok: true });
      }
      if (url.pathname === "/api/v1/freebuff/session") {
        if (req.method === "POST" || req.method === "GET") {
          return Response.json({
            status: "active",
            instanceId: "inst-1",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            remainingMs: 3_600_000,
            accessTier: "free",
            countryCode: "DE",
            model: "minimax/minimax-m2.7",
          });
        }
        if (req.method === "DELETE") return new Response(null, { status: 204 });
      }
      if (req.method === "POST" && url.pathname === "/api/v1/chat/completions") {
        const parsed = JSON.parse(body!);
        if (parsed.stream === true) {
          const sse = [
            openaiChunk({ role: "assistant" }, null),
            openaiChunk({ content: "Hello" }, null),
            openaiChunk({ content: " world" }, null),
            openaiChunk({}, "stop", { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 }),
            "data: [DONE]\n\n",
          ].join("");
          return new Response(sse, { headers: { "content-type": "text/event-stream" } });
        }
        return Response.json({
          id: "chatcmpl-1",
          model: "minimax/minimax-m2.7",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }
      return new Response("stub: not found", { status: 404 });
    },
  });
  return { port: server.port ?? 0, stop: () => server.stop(true) };
}

async function readListeningPort(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<number> {
  const iterator = child.stdout[Symbol.asyncIterator]();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 12_000;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`no listening line within 12s; stdout so far: ${JSON.stringify(buf)}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      iterator.next(),
      new Promise<typeof timer extends undefined ? never : "timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remaining);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (result === "timeout") throw new Error(`no listening line within 12s; stdout so far: ${JSON.stringify(buf)}`);
    if (result.done) {
      const code = await child.exited;
      const stderr = await new Response(child.stderr).text();
      throw new Error(`serve exited (code ${code}) before listening; stderr: ${stderr.trim()}`);
    }
    buf += dec.decode(result.value, { stream: true });
    const match = /listening 127\.0\.0\.1:(\d+)/.exec(buf);
    if (match !== null) return Number(match[1]!);
  }
}

function sseEvents(raw: string): Array<{ event: string; data: unknown }> {
  return raw
    .split("\n\n")
    .filter((frame) => frame.startsWith("event:"))
    .map((frame) => {
      const lines = frame.split("\n");
      const event = lines.find((l) => l.startsWith("event:"))!.slice("event:".length).trim();
      const dataLine = lines.find((l) => l.startsWith("data:"));
      return { event, data: dataLine === undefined ? null : JSON.parse(dataLine.slice("data:".length).trim()) };
    });
}

describe("freebuff proxy e2e", () => {
  let recorded: RecordedRequest[] = [];
  let stopStub: () => void = () => {};
  let root = "";
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let childPid = -1;
  let port = 0;
  let adminAuth = "";
  let inferenceKey = "";

  beforeAll(async () => {
    recorded = [];
    const stub = makeStubUpstream(recorded);
    stopStub = stub.stop;

    const guard =
      'T=$(mktemp -d) && [ -n "$T" ] && [ -d "$T" ] || exit 9; ' +
      `printf %s '${ADMIN_TOKEN}' > "$T/admin-token" && ` +
      'chmod 600 "$T/admin-token" && printf %s "$T"';
    const probe = Bun.spawn(["bash", "-c", guard], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(probe.stdout).text();
    const err = await new Response(probe.stderr).text();
    const code = await probe.exited;
    if (code !== 0 || out.trim() === "") throw new Error(`mktemp guard failed (exit ${code}): ${err.trim()}`);
    root = out.trim();

    child = Bun.spawn(["bun", "src/index.ts", "serve"], {
      cwd: REPO,
      env: {
        ...process.env,
        CLAUTH_PROXY_BIND: "127.0.0.1:0",
        CLAUTH_PROXY_STATE_DIR: join(root, "state"),
        CLAUTH_PROXY_ADMIN_TOKEN_FILE: join(root, "admin-token"),
        FREEBUFF_UPSTREAM_BASE_URL: `http://127.0.0.1:${stub.port}`,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    childPid = child.pid;
    port = await readListeningPort(child);
    adminAuth = `Bearer ${ADMIN_TOKEN}`;
  }, 20_000);

  afterAll(async () => {
    try {
      stopStub();
      if (child !== null) {
        child.kill("SIGTERM");
        const exitCode = await child.exited;
        expect(exitCode).toBe(0);
        let orphan = true;
        try {
          process.kill(childPid, 0);
        } catch (e) {
          orphan = (e as NodeJS.ErrnoException).code !== "ESRCH";
        }
        expect(orphan).toBe(false);
      }
    } finally {
      if (root !== "") rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("health serves the freebuff manifest", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "freebuff", version: "0.0.0", contract: "1.0" });
  });

  test("paste login completes and mints an inference key", async () => {
    const start = await fetch(`http://127.0.0.1:${port}/clauth/v1/accounts/login`, {
      method: "POST",
      headers: { authorization: adminAuth },
      body: JSON.stringify({}),
    });
    expect(start.status).toBe(201);
    const startBody: any = await start.json();
    expect(startBody.state).toBe("pending");
    expect(startBody.modes).toEqual(["paste"]);
    expect(startBody.url).toBe("https://freebuff.llm.pm");

    const paste = await fetch(`http://127.0.0.1:${port}/clauth/v1/accounts/login/${startBody.flow}`, {
      method: "POST",
      headers: { authorization: adminAuth, "content-type": "application/json" },
      body: JSON.stringify({ code: PASTE_TOKEN }),
    });
    expect(paste.status).toBe(200);
    const pasteBody: any = await paste.json();
    expect(pasteBody.state).toBe("done");
    expect(pasteBody.account.label).toMatch(/^freebuff fa82…f6a7$/);
    expect(pasteBody.inference_key).toMatch(/^clp_/);
    inferenceKey = pasteBody.inference_key;
    expect(pasteBody.account.plans).toEqual([{ id: "free", label: "Free" }]);

    const probe = recorded.find((r) => r.path === "/api/v1/freebuff/streak");
    expect(probe).toBeDefined();
    expect(probe!.authorization).toBe(`Bearer ${PASTE_TOKEN}`);
  });

  test("non-streaming inference converts anthropic tools to the openai wire and back", async () => {
    const accounts: any = await (await fetch(`http://127.0.0.1:${port}/clauth/v1/accounts`, { headers: { authorization: adminAuth } })).json();
    const accountId: string = accounts.accounts[0].id;

    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": inferenceKey, "content-type": "application/json" },
      body: JSON.stringify({
        model: "minimax/minimax-m2.7",
        max_tokens: 256,
        stream: false,
        messages: [{ role: "user", content: "what is the weather in SF?" }],
        tools: [{ name: "get_weather", description: "get weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
      }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.model).toBe("minimax/minimax-m2.7");
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content).toEqual([
      { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } },
    ]);
    expect(body.usage.input_tokens).toBe(10);
    expect(body.usage.output_tokens).toBe(5);

    const chat = recorded.filter((r) => r.path === "/api/v1/chat/completions").at(-1)!;
    const chatBody: any = chat.body;
    expect(chatBody.stream).toBe(false);
    expect(chatBody.model).toBe("minimax/minimax-m2.7");
    expect(chatBody.messages).toEqual([
      { role: "user", content: "what is the weather in SF?" },
    ]);
    expect(chatBody.tools).toEqual([
      { type: "function", function: { name: "get_weather", description: "get weather", parameters: { type: "object", properties: { city: { type: "string" } } } } },
    ]);
    expect(chatBody.codebuff_metadata.cost_mode).toBe("free");
    expectMetadataShape(chatBody.codebuff_metadata, "run-1", "inst-1");
    expect(chatBody.provider).toEqual({ data_collection: "deny" });
    expect(chat.userAgent).toContain("ai-sdk/openai-compatible");
  });

  test("streaming inference converts openai sse to anthropic sse events", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": inferenceKey, "content-type": "application/json" },
      body: JSON.stringify({
        model: "minimax/minimax-m2.7",
        max_tokens: 256,
        stream: true,
        messages: [{ role: "user", content: "say hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const events = sseEvents(raw);
    const names = events.map((e) => e.event);
    expect(names[0]).toBe("message_start");
    expect(names).toContain("content_block_start");
    expect(names.filter((n) => n === "content_block_delta").length).toBe(2);
    const deltas = events.filter((e) => e.event === "content_block_delta");
    expect(deltas.map((d) => (d.data as any).delta.text)).toEqual(["Hello", " world"]);
    const messageDelta = events.find((e) => e.event === "message_delta")!;
    expect((messageDelta.data as any).delta.stop_reason).toBe("end_turn");
    expect((messageDelta.data as any).usage.output_tokens).toBe(2);
    expect(names[names.length - 1]).toBe("message_stop");
  });

  test("count_tokens is local and exact", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "x-api-key": inferenceKey, "content-type": "application/json" },
      body: JSON.stringify({ model: "minimax/minimax-m2.7", messages: [{ role: "user", content: "hello world" }] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ input_tokens: 3 });
  });

  test("usage reads the session window and stats figures", async () => {
    const usage: any = await (await fetch(`http://127.0.0.1:${port}/clauth/v1/usage`, { headers: { authorization: adminAuth } })).json();
    const account = usage.accounts[0];
    expect(account.state).toBe("ready");
    const window = account.figures.find((f: any) => f.kind === "window");
    expect(window).toBeDefined();
    expect(window.unit).toBe("percent");
    expect(window.resets_at).toBeTruthy();
    const stats = account.figures.find((f: any) => f.kind === "stats");
    expect(stats).toBeDefined();
    expect(stats.requests.attempted).toBeGreaterThanOrEqual(2);
    expect(stats.requests.succeeded).toBeGreaterThanOrEqual(2);
    expect(stats.tokens.input).toBeGreaterThan(0);
  });

  test("end-session action deletes the upstream session", async () => {
    const accounts: any = await (await fetch(`http://127.0.0.1:${port}/clauth/v1/accounts`, { headers: { authorization: adminAuth } })).json();
    const accountId: string = accounts.accounts[0].id;
    const res = await fetch(`http://127.0.0.1:${port}/clauth/v1/accounts/${accountId}/actions/end-session`, {
      method: "POST",
      headers: { authorization: adminAuth, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    // the core answers 202 before the fire-and-forget action's DELETE crosses
    // the loopback: poll for the record instead of asserting on arrival order
    const deadline = Date.now() + 2000;
    let del: RecordedRequest | undefined;
    while (Date.now() < deadline) {
      del = recorded.find((r) => r.method === "DELETE" && r.path === "/api/v1/freebuff/session");
      if (del !== undefined) break;
      await Bun.sleep(20);
    }
    expect(del).toBeDefined();
    expect(del!.authorization).toBe(`Bearer ${PASTE_TOKEN}`);
  });
});
