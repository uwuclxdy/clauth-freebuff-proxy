/**
 * The freebuff adapter: the manifest the core serves from, the login doors
 * (src/login.ts), the anthropic↔openai forward over the run chain
 * (src/sessions.ts + src/convert.ts), the session-window and stats
 * figures, and the `end-session` action.
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
import { catalogueOf, endAccountSessions, instanceIdOf, requestGapMs, runChat } from "./sessions.ts";
import { dropStats, recordTokens, statsCounters } from "./stats.ts";

/** The freebuff session window's nominal length: one hour. */
const WINDOW_SECS = 3600;
const WINDOW_MS = WINDOW_SECS * 1000;
/** The usage cache must see a fresh account's window before a client asks: the first poll lands on the first interval. */
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
      const converted = convertOpenAiSse(upstreamBody, row.key, (tokens) => recordTokens(ctx.accountId, tokens));
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

interface SessionFigureBody {
  status: string;
  instanceId: string;
  expiresAt: string;
  remainingMs: number;
}

function readSessionFigureBody(raw: unknown): SessionFigureBody {
  const body = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const stringAt = (key: string): string => (typeof body[key] === "string" ? (body[key] as string) : "");
  const numberAt = (key: string): number => (typeof body[key] === "number" ? (body[key] as number) : 0);
  return {
    status: stringAt("status"),
    instanceId: stringAt("instanceId"),
    expiresAt: stringAt("expiresAt"),
    remainingMs: numberAt("remainingMs"),
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
  const session = readSessionFigureBody(body);
  if (status === 200 && session.status === "active" && session.instanceId !== "") {
    const used = Math.min(100, Math.max(0, Math.round(100 * (1 - session.remainingMs / WINDOW_MS))));
    const resetsAt = Date.parse(session.expiresAt);
    figures.push({
      kind: "window",
      id: "session",
      label: "session window",
      read_at: readAt,
      used,
      limit: 100,
      unit: "percent",
      window_secs: WINDOW_SECS,
      resets_at: Number.isFinite(resetsAt) ? new Date(resetsAt).toISOString() : null,
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
      { id: "session", kind: "window", label: "session window" },
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
