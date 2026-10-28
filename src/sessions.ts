/**
 * The per-account upstream state and the chat run chain — sessionless until a
 * 428 asks for one admission: the
 * model catalogue fetched once per account (a 409 `freebuff_catalog_stale`
 * asks for one refetch), the locally minted `cli:` instance id every chat
 * and the session figure ride, one agent run per chat (START → chat →
 * FINISH) on the free-catalog agent, the request-gap debounce between an
 * account's chats, and the freebuff extension fields on the chat body. Every
 * upstream request the chain makes feeds the account's stats counters.
 */

import { randomUUID } from "node:crypto";
import { AdapterError } from "clauth-proxy-core";
import { ConvertError } from "./convert.ts";
import { parseCatalogue, resolveRow, type Catalogue } from "./models.ts";
import { recordUpstream } from "./stats.ts";
import {
  ADMISSION_PATH,
  AGENT_RUNS_PATH,
  CHAT_PATH,
  CLI_VERSION,
  MODELS_PATH,
  SESSION_PATH,
  retryAfterSeconds,
  upstreamRequest,
  upstreamRequestJson,
  type HeaderPair,
  type UpstreamJson,
  type UpstreamRequest,
} from "./transport.ts";

/** The run agent the CLI 0.2.34 free-catalog chats START. */
const RUN_AGENT = "base3-free-catalog";
const CATALOG_PROTOCOL = "1";
/** The completion's gzip-recovery header, sent by the CLI on every chat. */
const SSE_GZIP_RECOVERY: HeaderPair = ["x-freebuff-sse-gzip-recovery", "1"];

// The CLI capture's own descriptor values (2026-10-27): the upstream has
// only ever seen these exact strings from the official client.
const CLI_CLIENT_ENV =
  "v1;in=1;out=1;tp=tmux;term=1;ct=1;sz=220x50;ci=0;ssh=0;l=0;p=shell;g=mux;osc=1;tzo=0;px=none;tls=1;ca=0;cde=none";
const CLI_INPUT_PROFILE = "v1;tc=0;ke=0;mc=0;pc=0;pe=0;cps=0";
const CLI_REPO_SNAPSHOT =
  '{"gitAvailable":true,"repositoryVisibility":"unknown","fileCount":1,"fileCountIsLowerBound":false,"testFileCount":0,"historyIsShallow":false,"changedFileCount":0,"changedFileScanTruncated":false}';

interface AccountUpstream {
  catalogue: Catalogue | null;
  instanceId: string | null;
  clientId: string | null;
  lastChatDialAt: number;
}

const accounts = new Map<string, AccountUpstream>();

function accountState(accountId: string): AccountUpstream {
  let entry = accounts.get(accountId);
  if (entry === undefined) {
    entry = { catalogue: null, instanceId: null, clientId: null, lastChatDialAt: 0 };
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
  dialGates.delete(accountId);
}

/** The account's locally minted `cli:` instance id, minted on first use. */
export function instanceIdOf(accountId: string): string {
  const account = accountState(accountId);
  if (account.instanceId === null) account.instanceId = `cli:${randomUUID()}`;
  return account.instanceId;
}

/** The account's chat client id: the CLI capture shows a stable 10-character
 * lowercase id across a conversation. */
export function clientIdOf(accountId: string): string {
  const account = accountState(accountId);
  if (account.clientId === null) {
    let out = "";
    while (out.length < 10) out += Math.floor(Math.random() * 36).toString(36);
    account.clientId = out.slice(0, 10);
  }
  return account.clientId;
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

function upstreamFailure(what: string, status: number, retryAfter: number | undefined): AdapterError {
  if (status === 401) return new AdapterError("login_required", `${what}: the token was rejected (${status})`);
  if (status === 429) return new AdapterError("rate_limited", `${what}: rate limited (${status})`, retryAfter);
  return new AdapterError("upstream_unavailable", `${what}: upstream answered ${status}`);
}

// ---- the model catalogue ----------------------------------------------------

/** Forget the cached catalogue; the next read refetches it. */
export function dropCatalogue(accountId: string): void {
  accountState(accountId).catalogue = null;
}

/** The account's model catalogue, fetched once and cached. */
export async function catalogueOf(accountId: string, token: string): Promise<Catalogue> {
  const account = accountState(accountId);
  if (account.catalogue !== null) return account.catalogue;
  const { status, body, retryAfter } = await countedJson(accountId, {
    path: MODELS_PATH,
    method: "GET",
    token,
    headerClass: "cli",
    extraHeaders: [["x-freebuff-catalog-protocol", CATALOG_PROTOCOL]],
    timeoutMs: 60_000,
  });
  if (status !== 200) throw upstreamFailure("catalogue", status, retryAfter);
  const catalogue = parseCatalogue(body);
  if (catalogue === null) throw new AdapterError("upstream_unavailable", "catalogue: the upstream answer carried no rows");
  account.catalogue = catalogue;
  return catalogue;
}

// ---- the session wire -------------------------------------------------------

/** End the account's upstream session; a missing one (404) is already ended. */
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

/** End the account's upstream session. */
export async function endAccountSessions(accountId: string, token: string): Promise<void> {
  await endSession(accountId, token, instanceIdOf(accountId));
}

/** Start the account's free session through the admission door; a non-2xx answer is upstream trouble. */
async function admitSession(accountId: string, token: string, handle: string, fetchId: string | null): Promise<void> {
  const instanceId = instanceIdOf(accountId);
  const extra: HeaderPair[] = [
    ["x-freebuff-client", "cli"],
    ["x-freebuff-client-version", CLI_VERSION],
    ["x-freebuff-multi-session", "1"],
    ["x-freebuff-purchase-continuity", "1"],
    ["x-freebuff-desktop-attempt-id", instanceId.replace(/^cli:/, "")],
    ["x-freebuff-instance-id", instanceId],
    ["x-freebuff-model", handle],
    ["x-freebuff-wallet-spend-limit", "session"],
    ["x-freebuff-catalog-protocol", CATALOG_PROTOCOL],
  ];
  if (fetchId !== null) extra.push(["x-freebuff-catalog-fetch", fetchId]);
  const { status, retryAfter } = await countedJson(accountId, {
    path: ADMISSION_PATH,
    method: "POST",
    token,
    headerClass: "cli",
    extraHeaders: extra,
  });
  if (status < 200 || status >= 300) throw upstreamFailure("session admission", status, retryAfter);
}

// ---- the run chain ----------------------------------------------------------

export async function startRun(accountId: string, token: string): Promise<string> {
  const { status, body, retryAfter } = await countedJson(accountId, {
    path: AGENT_RUNS_PATH,
    method: "POST",
    token,
    headerClass: "api",
    body: { action: "START", agentId: RUN_AGENT, ancestorRunIds: [] },
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

/** The freebuff extension fields on an openai chat body (the CLI 0.2.34 wire). */
export function assembleChatBody(converted: Record<string, unknown>, runId: string, instanceId: string, clientId: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    run_id: runId,
    client_id: clientId,
    trace_session_id: randomUUID(),
    cost_mode: "free",
    freebuff_instance_id: instanceId,
    freebuff_multi_session: "1",
    surface: "cli",
    freebuff_client_env: CLI_CLIENT_ENV,
    freebuff_input_profile: CLI_INPUT_PROFILE,
    repo_snapshot: CLI_REPO_SNAPSHOT,
    llm_step_number: "1",
  };
  return {
    ...converted,
    codebuff_metadata: metadata,
    provider: { data_collection: "deny" },
  };
}

function isRunIdError(status: number, body: unknown): boolean {
  if (status !== 400) return false;
  const message = body === null ? "" : JSON.stringify(body);
  return message.includes("runid not found") || message.includes("runid not running");
}

function isCatalogStale(status: number, body: unknown): boolean {
  if (status !== 409) return false;
  return JSON.stringify(body ?? "").includes("freebuff_catalog_stale");
}

function isSessionModelMismatch(status: number, body: unknown): boolean {
  if (status < 400 || status >= 500 || status === 428) return false;
  return JSON.stringify(body ?? "").includes("session_model_mismatch");
}

function isWaitingRoomRequired(status: number, body: unknown): boolean {
  if (status !== 428) return false;
  return JSON.stringify(body ?? "").includes("waiting_room_required");
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

async function postChat(accountId: string, token: string, body: Record<string, unknown>, gapMs: number): Promise<Response> {
  await dialGate(accountId, gapMs);
  return countedSend(accountId, {
    path: CHAT_PATH,
    method: "POST",
    token,
    headerClass: "chat",
    extraHeaders: [SSE_GZIP_RECOVERY],
    body,
    timeoutMs: 300_000,
  });
}

export interface ChatPlan {
  accountId: string;
  token: string;
  /** The catalogue row key the client addressed; the chat answer reports it. */
  model: string;
  /** The row's signed handle; the chat body's `model` field carries it. */
  handle: string;
  /** The catalogue's fetchId, carried by a session admission when non-null. */
  fetchId: string | null;
  body: Record<string, unknown>;
  gapMs: number;
}

export interface ChatAttempt {
  response: Response;
  /** FINISH for the run this chat rode; call once the answer is fully sent. */
  finish: () => Promise<void>;
}

/**
 * One chat on the account's behalf: a fresh agent run, the POST
 * behind the account's dial gate, and one bounded retry per error class — a
 * dead run (`runid not found`/`runid not running`), a stale catalogue
 * (`freebuff_catalog_stale`, one refetch), a `session_model_mismatch`
 * (the server session ends once), and a waiting room
 * (`waiting_room_required`, one session admission).
 */
export async function runChat(plan: ChatPlan): Promise<ChatAttempt> {
  const { accountId, token, model, body: converted, gapMs } = plan;
  let handle = plan.handle;
  let fetchId = plan.fetchId;
  let runId = await startRun(accountId, token);
  let response = await postChat(accountId, token, assembleChatBody({ ...converted, model: handle }, runId, instanceIdOf(accountId), clientIdOf(accountId)), gapMs);

  let retriedRun = false;
  let retriedCatalog = false;
  let retriedMismatch = false;
  let retriedAdmission = false;
  for (;;) {
    if (response.status < 400) break;
    const errorBody = await readErrorBody(response);
    if (!retriedRun && isRunIdError(response.status, errorBody)) {
      retriedRun = true;
      runId = await startRun(accountId, token);
      response = await postChat(accountId, token, assembleChatBody({ ...converted, model: handle }, runId, instanceIdOf(accountId), clientIdOf(accountId)), gapMs);
    } else if (isCatalogStale(response.status, errorBody)) {
      if (retriedCatalog) {
        throw new AdapterError("upstream_unavailable", "chat: the refetched catalogue still answers freebuff_catalog_stale");
      }
      retriedCatalog = true;
      dropCatalogue(accountId);
      const catalogue = await catalogueOf(accountId, token);
      const fresh = resolveRow(catalogue, model);
      if (fresh === null) throw new ConvertError(`unknown model ${JSON.stringify(model)}`);
      handle = fresh.handle;
      fetchId = catalogue.fetchId;
      runId = await startRun(accountId, token);
      response = await postChat(accountId, token, assembleChatBody({ ...converted, model: handle }, runId, instanceIdOf(accountId), clientIdOf(accountId)), gapMs);
    } else if (isSessionModelMismatch(response.status, errorBody)) {
      if (retriedMismatch) {
        throw new AdapterError(
          "upstream_unavailable",
          `chat: the upstream session stays bound to ${JSON.stringify(mismatchedModel(errorBody) ?? "another model")} while ${JSON.stringify(model)} was requested`,
        );
      }
      retriedMismatch = true;
      await endSession(accountId, token, instanceIdOf(accountId));
      runId = await startRun(accountId, token);
      response = await postChat(accountId, token, assembleChatBody({ ...converted, model: handle }, runId, instanceIdOf(accountId), clientIdOf(accountId)), gapMs);
    } else if (isWaitingRoomRequired(response.status, errorBody)) {
      if (retriedAdmission) {
        throw new AdapterError("upstream_unavailable", "chat: the admitted session still answers waiting_room_required");
      }
      retriedAdmission = true;
      await admitSession(accountId, token, handle, fetchId);
      response = await postChat(accountId, token, assembleChatBody({ ...converted, model: handle }, runId, instanceIdOf(accountId), clientIdOf(accountId)), gapMs);
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

const dialGates = new Map<string, Promise<void>>();

/**
 * The dial gate, serialized per account through a promise-chain lock: the
 * chat POST dispatches only once the account's previous chat POST is `gapMs`
 * old, read off the shared last-dial timestamp under the gate. Only the
 * dispatch sits inside the gate — run setup never holds it, so two
 * concurrent chats cannot both read the same last-dial time and dial inside
 * the gap the freebuff client itself keeps.
 */
async function dialGate(accountId: string, gapMs: number): Promise<void> {
  const previous = dialGates.get(accountId) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  dialGates.set(accountId, previous.then(() => held));
  await previous;
  try {
    const account = accountState(accountId);
    const wait = account.lastChatDialAt + gapMs - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    account.lastChatDialAt = Date.now();
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
