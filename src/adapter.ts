/**
 * The freebuff adapter: the manifest the core serves from, the login doors
 * (src/login.ts), the anthropic↔openai forward over the run chain
 * (src/sessions.ts + src/convert.ts), the session-pool and stats figures, and
 * the `end-session` action.
 */

import {
  AdapterError,
  type DropLoginContext,
  type ForwardContext,
  type ProxyAdapter,
  type ReadFiguresContext,
  type RunActionContext,
} from "clauth-proxy-core";
import {
  ConvertError,
  countAnthropicTokens,
  convertOpenAiSse,
  openAiUsageOf,
  parseAnthropicRequest,
  toAnthropicMessage,
  toOpenAiBody,
} from "./convert.ts";
import { dropAccount } from "./sessions.ts";
import { loginCancel, loginPaste, loginPoll, loginStart, tokenFromBlob } from "./login.ts";
import { resolveRow } from "./models.ts";
import { SESSION_PATH, upstreamRequestJson } from "./transport.ts";
import { catalogueOf, chatModelOf, endAccountSessions, instanceIdOf, noteChatModel, requestGapMs, runChat } from "./sessions.ts";
import { dropStats, recordTokens, statsCounters } from "./stats.ts";

/** The usage cache must see a fresh account's figures before a client asks: the first poll lands on the first interval. */
const USAGE_CADENCE_MS = 1000;

function invalidRequest(message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

async function forwardMessages(ctx: ForwardContext, token: string): Promise<Response> {
  try {
    const parsed = parseAnthropicRequest(await ctx.request.json());
    const catalogue = await catalogueOf(ctx.accountId, token);
    const row = resolveRow(catalogue, parsed.model);
    if (row === null) return invalidRequest(`unknown model ${JSON.stringify(parsed.model)}`);

    const attempt = await runChat({
      accountId: ctx.accountId,
      token,
      model: row.key,
      handle: row.handle,
      fetchId: catalogue.fetchId,
      // the chat body dials the row's signed handle, never the client's id
      body: toOpenAiBody({ ...parsed, model: row.handle }),
      gapMs: requestGapMs(ctx.account.settings),
    });

    if (parsed.stream && attempt.response.ok) {
      const upstreamBody = attempt.response.body;
      if (upstreamBody === null) throw new AdapterError("upstream_unavailable", "chat: the upstream answer carried no body");
      const converted = convertOpenAiSse(
        upstreamBody,
        row.key,
        (tokens) => recordTokens(ctx.accountId, tokens),
        (model) => noteChatModel(ctx.accountId, model),
      );
      return new Response(
        converted.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            flush() {
              return attempt.finish();
            },
          }),
        ),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }

    const text = await attempt.response.text();
    let upstream: unknown;
    try {
      upstream = JSON.parse(text) as unknown;
    } catch {
      throw new AdapterError("upstream_unavailable", "chat: the upstream body was not JSON");
    }
    await attempt.finish();
    if (!attempt.response.ok) {
      // a non-2xx answer that survived the retries passes through; the core maps it by status
      return new Response(JSON.stringify(upstream), {
        status: attempt.response.status,
        headers: { "content-type": "application/json" },
      });
    }
    recordTokens(ctx.accountId, openAiUsageOf(upstream));
    noteChatModel(ctx.accountId, upstreamModelOf(upstream));
    return Response.json(toAnthropicMessage(upstream, row.key));
  } catch (err) {
    if (err instanceof ConvertError) return invalidRequest(err.message);
    throw err;
  }
}

async function forward(ctx: ForwardContext): Promise<Response> {
  const token = tokenFromBlob(ctx.account.blob);
  if (token === null) throw new AdapterError("login_required", "the account holds no freebuff token");
  if (ctx.route === "count_tokens") {
    let count: number;
    try {
      count = countAnthropicTokens(await ctx.request.json());
    } catch (err) {
      if (err instanceof ConvertError) return invalidRequest(err.message);
      throw err;
    }
    return Response.json({ input_tokens: count });
  }
  return forwardMessages(ctx, token);
}

/** The upstream model id a chat answer reported, or "" when it carried none. */
function upstreamModelOf(raw: unknown): string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "";
  const model = (raw as Record<string, unknown>)["model"];
  return typeof model === "string" ? model : "";
}

interface PoolEntry {
  used: number;
  limit: number;
  windowSecs: number;
  resetsAt: string | null;
}

/** The daily free-session pool the session answer reports for one upstream
 * model. The pools key on the upstream model id, which only a chat answer
 * names for a catalogue row, so the caller passes the id the last chat
 * reported; without one the answer carries no readable pool. */
function poolOf(raw: unknown, upstreamModel: string): PoolEntry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const pools = (raw as Record<string, unknown>)["rateLimitsByModel"];
  if (typeof pools !== "object" || pools === null || Array.isArray(pools)) return null;
  const entry = (pools as Record<string, unknown>)[upstreamModel];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const used = record["recentCount"];
  const limit = record["limit"];
  if (typeof used !== "number" || typeof limit !== "number" || limit <= 0) return null;
  const hours = record["windowHours"];
  // the core's figure schema takes only UTC timestamps; the upstream may send an offset
  const resetMs = typeof record["resetAt"] === "string" ? Date.parse(record["resetAt"] as string) : Number.NaN;
  return {
    used,
    limit,
    windowSecs: typeof hours === "number" && hours > 0 ? Math.round(hours * 3600) : 86_400,
    resetsAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
  };
}

async function readFigures(ctx: ReadFiguresContext): Promise<unknown> {
  const token = tokenFromBlob(ctx.account.blob);
  if (token === null) throw new AdapterError("login_required", "usage: the account holds no freebuff token");

  const readAt = new Date().toISOString();
  const instanceId = instanceIdOf(ctx.accountId);
  const { status, body, retryAfter } = await upstreamRequestJson({
    path: SESSION_PATH,
    method: "GET",
    token,
    headerClass: "cli",
    extraHeaders: instanceId === null ? [] : [["x-freebuff-instance-id", instanceId]],
  });
  if (status === 401) throw new AdapterError("login_required", "usage: the token was rejected (401)");
  if (status === 429) throw new AdapterError("rate_limited", "usage: rate limited (429)", retryAfter);
  if (status >= 400 && status !== 404) {
    throw new AdapterError("upstream_unavailable", `usage: upstream answered ${status}`);
  }

  const figures: unknown[] = [];
  const upstreamModel = chatModelOf(ctx.accountId);
  const pool = upstreamModel === null ? null : poolOf(body, upstreamModel);
  if (status === 200 && pool !== null) {
    figures.push({
      kind: "window",
      id: "session",
      label: "daily session pool",
      read_at: readAt,
      used: pool.used,
      limit: pool.limit,
      unit: "custom",
      unit_label: "sessions",
      window_secs: pool.windowSecs,
      resets_at: pool.resetsAt,
    });
  }
  figures.push({
    kind: "stats",
    id: "stats",
    label: "request stats",
    read_at: readAt,
    summary: "upstream requests incl. the session and run chain",
    ...statsCounters(ctx.accountId),
  });
  return figures;
}

async function runAction(ctx: RunActionContext): Promise<void> {
  if (ctx.action !== "end-session") throw new Error(`actions: unknown action ${JSON.stringify(ctx.action)}`);
  const token = tokenFromBlob(ctx.account.blob);
  if (token === null) throw new AdapterError("login_required", "end-session: the account holds no freebuff token");
  await endAccountSessions(ctx.accountId, token);
}

/** An account gone from the core takes its proxy-side state with it. */
async function dropLogin(ctx: DropLoginContext): Promise<void> {
  if (ctx.accountId === null) return;
  dropStats(ctx.accountId);
  dropAccount(ctx.accountId);
}

export const adapter: ProxyAdapter = {
  manifest: {
    service: "freebuff",
    display_name: "Freebuff",
    description: "free models via the freebuff CLI's free tier (unofficial)",
    version: "0.0.0",
    capabilities: ["events", "count_tokens"],
    figures: [
      { id: "session", kind: "window", label: "daily session pool" },
      { id: "stats", kind: "stats", label: "request stats" },
    ],
    settings: [
      {
        key: "request_gap_ms",
        scope: "account",
        label: "request gap",
        hint: "Minimum milliseconds between this account's chat requests, the gap the freebuff client itself keeps",
        type: "int",
        default: 1300,
        min: 0,
        max: 60000,
        step: 100,
        unit: "ms",
        restart: false,
      },
    ],
    actions: [{ name: "end-session", label: "end session", scope: "account", confirm: true }],
    usage_cadence_ms: USAGE_CADENCE_MS,
  },

  loginStart,
  loginPoll,
  loginPaste,
  loginCancel,
  forward,
  readFigures,
  runAction,
  dropLogin,
};
