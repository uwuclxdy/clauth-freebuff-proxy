/**
 * The per-account+model session cache and the chat run chain:
 * Q-c/Q-e): one freebuff session per account+model, one agent run per chat
 * (START → chat → FINISH), the request-gap debounce between an account's
 * chats, and the freebuff extension fields on the chat body. Every upstream
 * request the chain makes feeds the account's stats counters.
 */

import { randomUUID } from "node:crypto";
import { AdapterError } from "clauth-proxy-core";
import { mintSessionId } from "./convert.ts";
import { resolveModel } from "./models.ts";
import { recordUpstream } from "./stats.ts";
import {
  AGENT_RUNS_PATH,
  CHAT_PATH,
  SESSION_PATH,
  retryAfterSeconds,
  upstreamRequest,
  upstreamRequestJson,
  type HeaderPair,
  type UpstreamJson,
  type UpstreamRequest,
} from "./transport.ts";

export interface SessionEntry {
  instanceId: string;
  /** The model the upstream actually bound (it may differ from the request). */
  model: string;
  expiresAtEpoch: number;
}

interface AccountUpstream {
  sessionsByModel: Map<string, SessionEntry>;
  lastChatStartedAt: number;
}

const accounts = new Map<string, AccountUpstream>();

function accountState(accountId: string): AccountUpstream {
  let entry = accounts.get(accountId);
  if (entry === undefined) {
    entry = { sessionsByModel: new Map(), lastChatStartedAt: 0 };
    accounts.set(accountId, entry);
  }
  return entry;
}

export const DEFAULT_REQUEST_GAP_MS = 1300;

export function requestGapMs(settings: Record<string, unknown>): number {
  const value = settings["request_gap_ms"];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : DEFAULT_REQUEST_GAP_MS;
}

export function dropAccount(accountId: string): void {
  accounts.delete(accountId);
  gapLocks.delete(accountId);
}

/** Any live session's instance id, for the account-scoped session GET. */
export function anyCachedInstanceId(accountId: string): string | null {
  for (const entry of accountState(accountId).sessionsByModel.values()) {
    if (entry.expiresAtEpoch > Date.now()) return entry.instanceId;
  }
  return null;
}

// ---- counted wire -----------------------------------------------------------

async function countedJson(accountId: string, req: UpstreamRequest): Promise<UpstreamJson> {
  const startedAt = Date.now();
  const answer = await upstreamRequestJson(req);
  recordUpstream(accountId, answer.status < 400, Date.now() - startedAt);
  return answer;
}

async function countedSend(accountId: string, req: UpstreamRequest): Promise<Response> {
  const startedAt = Date.now();
  const res = await upstreamRequest(req);
  recordUpstream(accountId, res.status < 400, Date.now() - startedAt);
  return res;
}

// ---- session wire -----------------------------------------------------------

interface SessionBody {
  status: string;
  instanceId: string;
  expiresAt: string;
  estimatedWaitMs: number;
  model: string;
  currentModel: string;
  error: string;
}

function readSessionBody(raw: unknown): SessionBody {
  const body = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const stringAt = (key: string): string => (typeof body[key] === "string" ? (body[key] as string) : "");
  const numberAt = (key: string): number => (typeof body[key] === "number" ? (body[key] as number) : 0);
  return {
    status: stringAt("status"),
    instanceId: stringAt("instanceId"),
    expiresAt: stringAt("expiresAt"),
    estimatedWaitMs: numberAt("estimatedWaitMs"),
    model: stringAt("model"),
    currentModel: stringAt("currentModel"),
    error: stringAt("error"),
  };
}

function upstreamFailure(what: string, status: number, retryAfter: number | undefined): AdapterError {
  if (status === 401) return new AdapterError("login_required", `${what}: the token was rejected (${status})`);
  if (status === 429) return new AdapterError("rate_limited", `${what}: rate limited (${status})`, retryAfter);
  return new AdapterError("upstream_unavailable", `${what}: upstream answered ${status}`);
}

function sessionInvalid(status: number, body: SessionBody): boolean {
  return status === 426 || body.error === "freebuff_update_required";
}

function sessionModelLocked(body: SessionBody): boolean {
  return body.error === "model_locked";
}

/** The bound model a `session_model_mismatch` names. */
function mismatchedModel(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const error = typeof record["error"] === "object" && record["error"] !== null ? (record["error"] as Record<string, unknown>) : {};
  const locked = error["lockedModel"] ?? record["lockedModel"];
  if (typeof locked === "string" && locked !== "") return locked;
  const message = JSON.stringify(body);
  const bound = /bound to ([a-zA-Z0-9][a-zA-Z0-9._/-]+)/.exec(message);
  return bound?.[1] ?? null;
}

function isSessionModelMismatch(status: number, body: unknown): boolean {
  if (status < 400 || status >= 500) return false;
  return JSON.stringify(body ?? "").includes("session_model_mismatch");
}

interface SessionAnswer {
  status: number;
  body: SessionBody;
  retryAfter: number | undefined;
}

async function createSession(accountId: string, token: string, model: string): Promise<SessionAnswer> {
  const { status, body, retryAfter } = await countedJson(accountId, {
    path: SESSION_PATH,
    method: "POST",
    token,
    headerClass: "cli",
    body: {},
    extraHeaders: [["x-freebuff-model", model]],
    timeoutMs: 60_000,
  });
  return { status, body: readSessionBody(body), retryAfter };
}

async function getSession(accountId: string, token: string, instanceId: string | null): Promise<SessionAnswer> {
  const extra: HeaderPair[] = instanceId === null ? [] : [["x-freebuff-instance-id", instanceId]];
  const { status, body, retryAfter } = await countedJson(accountId, {
    path: SESSION_PATH,
    method: "GET",
    token,
    headerClass: "cli",
    extraHeaders: extra,
    timeoutMs: 60_000,
  });
  return { status, body: readSessionBody(body), retryAfter };
}

/** End one upstream session; a missing one (404) is already ended. */
export async function endSession(accountId: string, token: string, instanceId: string | null): Promise<void> {
  const extra: HeaderPair[] = instanceId === null ? [] : [["x-freebuff-instance-id", instanceId]];
  const res = await countedSend(accountId, {
    path: SESSION_PATH,
    method: "DELETE",
    token,
    headerClass: "cli",
    extraHeaders: extra,
    timeoutMs: 30_000,
  });
  await res.body?.cancel().catch(() => {});
  if (res.status === 404 || res.status < 300) return;
  throw upstreamFailure("session end", res.status, retryAfterSeconds(res));
}

const QUEUED_POLL_FLOOR_MS = 1000;
const QUEUED_POLL_CAP_MS = 2000;
const QUEUED_POLL_MAX_ATTEMPTS = 30;

/**
 * Poll a queued session until it opens. Only `active` settles; `queued` keeps
 * polling. An ended/superseded session asks for the invalidation path; a
 * 404/none/disabled queue is a sessionless account.
 */
async function pollQueuedSession(
  accountId: string,
  token: string,
  instanceId: string,
  estimatedWaitMs: number,
): Promise<{ kind: "active"; body: SessionBody } | { kind: "invalidate" } | { kind: "sessionless" }> {
  const delay = Math.min(Math.max(estimatedWaitMs, QUEUED_POLL_FLOOR_MS), QUEUED_POLL_CAP_MS);
  for (let attempt = 0; attempt < QUEUED_POLL_MAX_ATTEMPTS; attempt++) {
    await Bun.sleep(delay);
    const { status, body, retryAfter } = await getSession(accountId, token, instanceId);
    if (status === 404) return { kind: "sessionless" };
    if (status < 200 || status >= 300) throw upstreamFailure("session poll", status, retryAfter);
    if (body.status === "active") return { kind: "active", body };
    if (body.status === "queued") continue;
    if (body.status === "ended" || body.status === "superseded") return { kind: "invalidate" };
    return { kind: "sessionless" };
  }
  throw new AdapterError("upstream_unavailable", "session poll: the queue never opened");
}

function entryFromBody(body: SessionBody, fallbackModel: string): SessionEntry | null {
  const instanceId = body.instanceId.trim();
  if (instanceId === "") return null;
  const expiresAt = body.expiresAt === "" ? Number.POSITIVE_INFINITY : Date.parse(body.expiresAt);
  return {
    instanceId,
    model: body.model !== "" ? body.model : fallbackModel,
    expiresAtEpoch: Number.isFinite(expiresAt) ? expiresAt : Number.POSITIVE_INFINITY,
  };
}

async function invalidateAccountSession(accountId: string, token: string): Promise<void> {
  const account = accountState(accountId);
  for (const entry of account.sessionsByModel.values()) {
    await endSession(accountId, token, entry.instanceId);
  }
  account.sessionsByModel.clear();
}

/** End every session the account holds and forget them. */
export async function endAccountSessions(accountId: string, token: string): Promise<void> {
  await invalidateAccountSession(accountId, token);
}

/** Cache and answer a settled 2xx session; `recreates` bounds the invalidation retries. */
async function settleSession(accountId: string, token: string, model: string, answer: SessionAnswer, recreates: number): Promise<SessionEntry | null> {
  if (answer.body.status === "queued") {
    const instanceId = answer.body.instanceId;
    if (instanceId === "") throw upstreamFailure("session create (queued without an instance id)", answer.status, answer.retryAfter);
    const polled = await pollQueuedSession(accountId, token, instanceId, answer.body.estimatedWaitMs);
    if (polled.kind === "sessionless") return null;
    if (polled.kind === "invalidate") {
      if (recreates <= 0) throw new AdapterError("upstream_unavailable", "session create: the queue kept closing");
      await endSession(accountId, token, instanceId);
      const recreated = await createSession(accountId, token, model);
      if (recreated.status === 404) return null;
      if (recreated.status === 401 || recreated.status === 429 || recreated.status < 200 || recreated.status >= 300) {
        throw upstreamFailure("session create", recreated.status, recreated.retryAfter);
      }
      return settleSession(accountId, token, model, recreated, recreates - 1);
    }
    const entry = entryFromBody(polled.body, model);
    if (entry === null) return null;
    accountState(accountId).sessionsByModel.set(entry.model, entry);
    return entry;
  }
  if (answer.body.status !== "active") {
    throw upstreamFailure(`session create (status ${answer.body.status})`, answer.status, answer.retryAfter);
  }
  const entry = entryFromBody(answer.body, model);
  if (entry === null) throw upstreamFailure("session create (active without an instance id)", answer.status, answer.retryAfter);
  accountState(accountId).sessionsByModel.set(entry.model, entry);
  return entry;
}

/**
 * The account's live session for one model, or null when the upstream runs
 * sessionless: a 404/none/disabled session, or a `model_locked` that survives
 * its end-and-recreate, is a legitimate chat path. A
 * 426 and a closed queue each get one invalidation-and-recreate, always for
 * the requested model; a queued session is polled until active.
 */
export async function ensureSession(accountId: string, token: string, model: string): Promise<SessionEntry | null> {
  const account = accountState(accountId);
  const cached = account.sessionsByModel.get(model);
  if (cached !== undefined && cached.expiresAtEpoch > Date.now()) return cached;
  account.sessionsByModel.delete(model);

  let created = await createSession(accountId, token, model);
  if (created.status === 404) return null;
  if (created.status === 401 || created.status === 429) {
    throw upstreamFailure("session create", created.status, created.retryAfter);
  }

  if (sessionModelLocked(created.body)) {
    await endSession(accountId, token, anyCachedInstanceId(accountId));
    account.sessionsByModel.clear();
    created = await createSession(accountId, token, model);
    if (created.status === 404) return null;
    if (created.status === 401 || created.status === 429) {
      throw upstreamFailure("session create", created.status, created.retryAfter);
    }
    if (sessionModelLocked(created.body)) return null;
  } else if (sessionInvalid(created.status, created.body)) {
    await invalidateAccountSession(accountId, token);
    created = await createSession(accountId, token, model);
    if (created.status === 404) return null;
    if (created.status === 401 || created.status === 429) {
      throw upstreamFailure("session create", created.status, created.retryAfter);
    }
    if (sessionInvalid(created.status, created.body)) {
      throw upstreamFailure("session create", created.status, created.retryAfter);
    }
  }

  if (created.status < 200 || created.status >= 300) {
    throw upstreamFailure("session create", created.status, created.retryAfter);
  }
  return settleSession(accountId, token, model, created, 1);
}

// ---- run chain --------------------------------------------------------------

export async function startRun(accountId: string, token: string, agentId: string): Promise<string> {
  const { status, body, retryAfter } = await countedJson(accountId, {
    path: AGENT_RUNS_PATH,
    method: "POST",
    token,
    headerClass: "api",
    body: { action: "START", agentId, ancestorRunIds: [] },
  });
  if (status === 401 || status === 429) throw upstreamFailure("run start", status, retryAfter);
  if (status < 200 || status >= 300) throw upstreamFailure("run start", status, retryAfter);
  const runId =
    typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>)["runId"] : undefined;
  if (typeof runId !== "string" || runId === "") throw new AdapterError("upstream_unavailable", "run start: no runId in the answer");
  return runId;
}

/** The run's FINISH; a failure here is non-actionable — the run self-expires upstream. */
export async function finishRun(accountId: string, token: string, runId: string): Promise<void> {
  try {
    await countedJson(accountId, {
      path: AGENT_RUNS_PATH,
      method: "POST",
      token,
      headerClass: "api",
      body: { action: "FINISH", runId, status: "completed", totalSteps: 0, directCredits: 0, totalCredits: 0 },
    });
  } catch {
    // the chat already succeeded; a dropped FINISH costs nothing the client sees
  }
}

// ---- the chat call ----------------------------------------------------------

/** The freebuff extension fields on an openai chat body (the node proxy's shape). */
export function assembleChatBody(converted: Record<string, unknown>, runId: string, session: SessionEntry | null): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    run_id: runId,
    client_id: mintSessionId(),
    trace_session_id: randomUUID(),
    cost_mode: "free",
    ...(session !== null ? { freebuff_instance_id: session.instanceId } : {}),
  };
  return {
    ...converted,
    codebuff_metadata: metadata,
    provider: { data_collection: "deny" },
    ...("stop" in converted ? {} : { stop: ["cb_easp"] }),
  };
}

function isRunIdError(status: number, body: unknown): boolean {
  if (status !== 400) return false;
  const message = body === null ? "" : JSON.stringify(body);
  return message.includes("runid not found") || message.includes("runid not running");
}

async function postChat(accountId: string, token: string, body: Record<string, unknown>): Promise<Response> {
  return countedSend(accountId, {
    path: CHAT_PATH,
    method: "POST",
    token,
    headerClass: "chat",
    body,
    timeoutMs: 300_000,
  });
}

export interface ChatPlan {
  accountId: string;
  token: string;
  model: string;
  body: Record<string, unknown>;
  gapMs: number;
}

export interface ChatAttempt {
  response: Response;
  /** FINISH for the run this chat rode; call once the answer is fully sent. */
  finish: () => Promise<void>;
}

/**
 * One chat on the account's behalf: the request-gap debounce (serialized per
 * account), the session (sessionless tolerated), a fresh agent run, the POST,
 * and one bounded retry per error class — a dead run
 * (`runid not found`/`runid not running`), an invalidated session
 * (426/`freebuff_update_required`), and a `session_model_mismatch`.
 */
export async function runChat(plan: ChatPlan): Promise<ChatAttempt> {
  const { accountId, token, model, body: converted, gapMs } = plan;
  await waitOutRequestGap(accountId, gapMs);
  const modelEntry = resolveModel(model);
  if (modelEntry === null) throw new AdapterError("upstream_unavailable", `chat: unknown model ${JSON.stringify(model)}`);
  const canonical = modelEntry.id;

  let session = await ensureSession(accountId, token, canonical);
  let runId = await startRun(accountId, token, modelEntry.agentId);
  let response = await postChat(accountId, token, assembleChatBody({ ...converted, model: canonical }, runId, session));

  let retriedRun = false;
  let retriedInvalidation = false;
  let retriedModelMismatch = false;
  for (;;) {
    if (response.status < 400) break;
    const errorBody = await readErrorBody(response);
    if (!retriedRun && isRunIdError(response.status, errorBody)) {
      retriedRun = true;
      runId = await startRun(accountId, token, modelEntry.agentId);
      response = await postChat(accountId, token, assembleChatBody({ ...converted, model: canonical }, runId, session));
    } else if (!retriedInvalidation && sessionInvalid(response.status, readSessionBody(errorBody))) {
      retriedInvalidation = true;
      await invalidateAccountSession(accountId, token);
      session = await ensureSession(accountId, token, canonical);
      runId = await startRun(accountId, token, modelEntry.agentId);
      response = await postChat(accountId, token, assembleChatBody({ ...converted, model: canonical }, runId, session));
    } else if (isSessionModelMismatch(response.status, errorBody)) {
      if (retriedModelMismatch) {
        throw new AdapterError(
          "upstream_unavailable",
          `chat: the upstream session stays bound to ${JSON.stringify(mismatchedModel(errorBody) ?? "another model")} while ${JSON.stringify(canonical)} was requested`,
        );
      }
      retriedModelMismatch = true;
      await invalidateAccountSession(accountId, token);
      session = await ensureSession(accountId, token, canonical);
      runId = await startRun(accountId, token, modelEntry.agentId);
      response = await postChat(accountId, token, assembleChatBody({ ...converted, model: canonical }, runId, session));
    } else {
      response = rebuildJsonResponse(response, errorBody);
      break;
    }
  }

  const retryAfter = retryAfterSeconds(response);
  if (response.status === 401) throw upstreamFailure("chat", response.status, retryAfter);
  if (response.status === 429) throw upstreamFailure("chat", response.status, retryAfter);

  return { response, finish: () => finishRun(accountId, token, runId) };
}

const gapLocks = new Map<string, Promise<void>>();

/**
 * The request-gap wait, serialized per account through a promise-chain lock:
 * two concurrent chats must not both read the same `lastChatStartedAt`, or
 * both would dial inside the gap the freebuff client itself keeps.
 */
async function waitOutRequestGap(accountId: string, gapMs: number): Promise<void> {
  const previous = gapLocks.get(accountId) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  gapLocks.set(accountId, previous.then(() => held));
  await previous;
  try {
    const account = accountState(accountId);
    const wait = account.lastChatStartedAt + gapMs - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    account.lastChatStartedAt = Date.now();
  } finally {
    release();
  }
}

/**
 * Read a non-2xx body once for the error-string checks; the buffered JSON is
 * rewrapped without the framing headers a re-serialized body would lie about.
 */
async function readErrorBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function rebuildJsonResponse(response: Response, body: unknown): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  return new Response(body === null ? "null" : JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
