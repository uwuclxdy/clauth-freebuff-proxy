/**
 * The three header classes the freebuff CLI's client sends:
 * one base set plus a per-class user agent. Every upstream call rides one
 * class, so the upstream's fingerprint sees the shape it expects.
 */

import { upstreamBase } from "./origins.ts";

export type HeaderClass = "api" | "chat" | "cli";

export type HeaderPair = [name: string, value: string];

const ACCEPT_ENCODING = "gzip, deflate";

/** The client release whose wire this proxy speaks; its bundle's sha256 is 5d9f18b5a56ac80e457547ca3859766a28fd8ddd32c396492f2cdb28b92507e2. */
export const CLI_VERSION = "0.2.34";

const USER_AGENTS: Record<HeaderClass, string> = {
  api: "Bun/1.3.14",
  chat: "ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser",
  cli: `Freebuff-CLI/${CLI_VERSION}`,
};

/** The base set + Authorization + the class's user agent; `extra` rides last.
 * A `null` token drops the header: the CLI's login routes answer before any
 * account exists. */
export function upstreamHeaders(headerClass: HeaderClass, token: string | null, extra: HeaderPair[] = []): HeaderPair[] {
  const host = new URL(upstreamBase()).host;
  return [
    ["Accept", "*/*"],
    ["Accept-Encoding", ACCEPT_ENCODING],
    ["Connection", "keep-alive"],
    ["Host", host],
    ["User-Agent", USER_AGENTS[headerClass]],
    ...(token === null ? [] : ([["Authorization", `Bearer ${token}`]] as HeaderPair[])),
    ...extra,
  ];
}

export interface UpstreamRequest {
  path: string;
  method: "GET" | "POST" | "DELETE";
  token: string | null;
  headerClass: HeaderClass;
  /** JSON body; sent only on POST. */
  body?: unknown;
  extraHeaders?: HeaderPair[];
  /** Milliseconds until the open (connect + headers) is aborted; the body stream is never cut. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** One upstream request. Resolves once headers arrive; the body stream stays live. */
export async function upstreamRequest(req: UpstreamRequest): Promise<Response> {
  const headers = upstreamHeaders(req.headerClass, req.token, [
    ...(req.body !== undefined && req.method === "POST" ? ([["Content-Type", "application/json"]] as HeaderPair[]) : []),
    ...(req.extraHeaders ?? []),
  ]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(`${upstreamBase()}${req.path}`, {
      method: req.method,
      headers,
      ...(req.method === "POST" && req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export interface UpstreamJson {
  status: number;
  body: unknown;
  retryAfter: number | undefined;
}

/** One upstream request answered with parsed JSON (a non-JSON body reads as null). */
export async function upstreamRequestJson(req: UpstreamRequest): Promise<UpstreamJson> {
  const res = await upstreamRequest(req);
  const retryAfter = retryAfterSeconds(res);
  const text = await res.text();
  const body: unknown = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  return { status: res.status, body, retryAfter };
}

export function retryAfterSeconds(res: { headers: { get(name: string): string | null } }): number | undefined {
  const raw = res.headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export const CHAT_PATH = "/api/v1/chat/completions";
export const MODELS_PATH = "/api/v1/freebuff/models";
export const SESSION_PATH = "/api/v1/freebuff/session";
export const ADMISSION_PATH = "/api/v1/freebuff/session/admission";
export const AGENT_RUNS_PATH = "/api/v1/agent-runs";
export const STREAK_PATH = "/api/v1/freebuff/streak";
export const CLI_LOGIN_CODE_PATH = "/api/auth/cli/code";
export const CLI_LOGIN_STATUS_PATH = "/api/auth/cli/status";
