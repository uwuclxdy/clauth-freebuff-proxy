/**
 * The conformance/parity stub upstream: one freebuff-shaped server on
 * loopback answering the catalogue/session/run/chat/streak routes the proxy
 * dials, with the openai answers the conversions consume. Every freebuff
 * request is recorded verbatim (GET /__stub/requests) and unexpected routes
 * are counted (GET /__stub/stats) so a driver can fail loudly on a dial
 * neither harness expects.
 */

const PORT = Number(process.env.STUB_PORT);
if (!Number.isInteger(PORT) || PORT <= 0) {
  console.error("stub: STUB_PORT must be a port number");
  process.exit(1);
}

interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  headers: Array<[string, string]>;
  bodyRaw: string | null;
  at: number;
}

const recorded: RecordedRequest[] = [];
const stats = { requests: 0, unmatched: 0, chats: 0, logins: 0 };

/** The small two-row catalogue the stub serves; row 1 is the default open row. */
const CATALOGUE_ROWS = [
  { key: "m-61c26317cc", handle: "fbm1.stub.aaaa", displayName: "MiMo v2.6 Flash Slow", access: "open", dataUse: "service", premium: false },
  { key: "m-9b8a7c6d5e", handle: "fbm1.stub.bbbb", displayName: "DeepSeek V4 Flash", access: "open", dataUse: "training", premium: true },
];
const CHAT_KEY = CATALOGUE_ROWS[0]!.key;

/** The token a browser login would hand back once the harness says a user signed in. */
let loginToken: string | null = null;
const LOGIN_HASH = "a".repeat(64);

function activeSession(): Record<string, unknown> {
  return {
    status: "active",
    instanceId: "inst-1",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    remainingMs: 3_600_000,
    accessTier: "free",
    countryCode: "DE",
    model: CHAT_KEY,
  };
}

function sseChunk(delta: unknown, finishReason: string | null, model: string, usage?: unknown): string {
  return `data: ${JSON.stringify({ id: "chatcmpl-1", model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage === undefined ? {} : { usage }) })}\n\n`;
}

function sseAnswer(model: string): string {
  return [
    sseChunk({ role: "assistant" }, null, model),
    sseChunk({ content: "ok" }, null, model),
    sseChunk({}, "stop", model, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 0 } }),
    "data: [DONE]\n\n",
  ].join("");
}

/** The row the chat body's model (a signed handle) selects. */
function selectedRow(parsed: Record<string, unknown>): (typeof CATALOGUE_ROWS)[number] | undefined {
  return typeof parsed["model"] === "string" ? CATALOGUE_ROWS.find((row) => row.handle === parsed["model"]) : undefined;
}

function route(method: string, path: string, bodyRaw: string | null): Response | null {
  if (method === "GET" && path === "/api/v1/freebuff/streak") return Response.json({ streakDays: 3 });
  if (path === "/api/auth/cli/code" && method === "POST") {
    stats.logins += 1;
    const fingerprintId = bodyRaw === null ? "" : ((JSON.parse(bodyRaw) as Record<string, unknown>)["fingerprintId"] ?? "");
    return Response.json({
      loginUrl: "https://www.codebuff.com/login?auth_code=stub",
      fingerprintId,
      fingerprintHash: LOGIN_HASH,
      expiresAt: Date.now() + 600_000,
      expiresInMs: 600_000,
    });
  }
  if (path === "/api/auth/cli/status" && method === "GET") {
    if (loginToken === null) return new Response(JSON.stringify({ error: "Authentication failed" }), { status: 401 });
    return Response.json({
      user: { id: "user-1", email: "stub@example.com", name: "Stub User", authToken: loginToken, fingerprintId: "stub", fingerprintHash: LOGIN_HASH },
    });
  }
  if (path === "/api/v1/freebuff/models" && method === "GET") {
    return Response.json({
      protocol: 1,
      version: "v0.stub.1",
      fetchId: "fbf1.stub",
      issuedAt: Date.now(),
      refreshAt: Date.now() + 3_600_000,
      rows: CATALOGUE_ROWS,
    });
  }
  if (path === "/api/v1/freebuff/session") {
    if (method === "POST" || method === "GET") return Response.json(activeSession());
    if (method === "DELETE") return new Response(null, { status: 204 });
    return null;
  }
  if (path === "/api/v1/agent-runs" && method === "POST") {
    const action = bodyRaw === null ? "" : ((JSON.parse(bodyRaw) as Record<string, unknown>)["action"] ?? "");
    return Response.json(action === "START" ? { runId: "run-1" } : {});
  }
  if (path === "/api/v1/chat/completions" && method === "POST") {
    stats.chats += 1;
    const parsed = bodyRaw === null ? {} : (JSON.parse(bodyRaw) as Record<string, unknown>);
    const stream = parsed["stream"] === true;
    const model = selectedRow(parsed)?.key ?? CHAT_KEY;
    if (stream) return new Response(sseAnswer(model), { headers: { "content-type": "text/event-stream" } });
    return Response.json({
      id: "chatcmpl-1",
      model,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 0 } },
    });
  }
  return null;
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/__stub/healthz") return Response.json({ ok: true });
  if (url.pathname === "/__stub/stats") return Response.json(stats);
  if (url.pathname === "/__stub/requests") return Response.json({ requests: recorded });
  if (url.pathname === "/__stub/login-ready" && req.method === "POST") {
    const body = (JSON.parse(await req.text()) as Record<string, unknown>)["authToken"];
    loginToken = typeof body === "string" ? body : null;
    return Response.json({ ok: true });
  }

  stats.requests += 1;
  const bodyRaw = req.method === "GET" || req.method === "DELETE" ? null : await req.text();
  recorded.push({
    method: req.method,
    path: url.pathname,
    search: url.search,
    headers: [...req.headers.entries()],
    bodyRaw,
    at: Date.now(),
  });
  const answer = route(req.method, url.pathname, bodyRaw);
  if (answer === null) {
    stats.unmatched += 1;
    console.log(`stub: UNMATCHED ${req.method} ${url.pathname}`);
    return new Response("stub: not found", { status: 404 });
  }
  return answer;
}

// loopback only: the stub answers unauthenticated by design
Bun.serve({ port: PORT, hostname: "127.0.0.1", fetch: handle });
console.log(`stub ready port=${PORT}`);
