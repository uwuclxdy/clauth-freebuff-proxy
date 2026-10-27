/**
 * The conformance/parity stub upstream: one freebuff-shaped server on
 * loopback answering the session/run/chat/streak routes the proxy dials, with
 * the openai answers the conversions consume. Every freebuff request is
 * recorded verbatim (GET /__stub/requests) and unexpected routes are counted
 * (GET /__stub/stats) so a driver can fail loudly on a dial neither harness
 * expects.
 */

const PORT = Number(process.env.STUB_PORT);
if (!Number.isInteger(PORT) || PORT <= 0) {
  console.error("stub: STUB_PORT must be a port number");
  process.exit(1);
}

interface RecordedRequest {
  method: string;
  path: string;
  headers: Array<[string, string]>;
  bodyRaw: string | null;
  at: number;
}

const recorded: RecordedRequest[] = [];
const stats = { requests: 0, unmatched: 0, chats: 0 };

const SESSION_MODEL = "minimax/minimax-m2.7";

function activeSession(): Record<string, unknown> {
  return {
    status: "active",
    instanceId: "inst-1",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    remainingMs: 3_600_000,
    accessTier: "free",
    countryCode: "DE",
    model: SESSION_MODEL,
  };
}

function sseChunk(delta: unknown, finishReason: string | null, usage?: unknown): string {
  return `data: ${JSON.stringify({ id: "chatcmpl-1", model: SESSION_MODEL, choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage === undefined ? {} : { usage }) })}\n\n`;
}

const SSE_ANSWER = [
  sseChunk({ role: "assistant" }, null),
  sseChunk({ content: "ok" }, null),
  sseChunk({}, "stop", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 0 } }),
  "data: [DONE]\n\n",
].join("");

function route(method: string, path: string, bodyRaw: string | null): Response | null {
  if (method === "GET" && path === "/api/v1/freebuff/streak") return Response.json({ streakDays: 3 });
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
    const stream = bodyRaw !== null && (JSON.parse(bodyRaw) as Record<string, unknown>)["stream"] === true;
    if (stream) return new Response(SSE_ANSWER, { headers: { "content-type": "text/event-stream" } });
    return Response.json({
      id: "chatcmpl-1",
      model: SESSION_MODEL,
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

  stats.requests += 1;
  const bodyRaw = req.method === "GET" || req.method === "DELETE" ? null : await req.text();
  recorded.push({
    method: req.method,
    path: url.pathname,
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
