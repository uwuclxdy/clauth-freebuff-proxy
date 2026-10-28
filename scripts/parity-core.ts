/**
 * The wire-parity comparator's pure core. The proxy's recorded upstream
 * requests compare against the shapes the 2026-10-27 live-drift capture pins
 * (docs/research/freebuff-wire-2026-10-27-live-drift/cli-capture.jsonl — the
 * capture is the parity reference, not a live client). Each request
 * classifies by method + path (+ body action for the agent-runs pair); each
 * class pins its header set in the capture's recorded order, the runtime
 * headers included (content-length on every body-carrying POST, content-type
 * on the chat wire), and its body's exact key set with volatile values
 * (token, client_id, trace_session_id, run ids, the minted cli: instance id)
 * classed by shape. The chat body's `messages` array compares by exact
 * equality against the scenario's pinned container; a scenario's
 * session-poll count compares exactly (the capture's chat exchanges dial no
 * session wire, so the one poll a harness slice holds is the usage cadence's
 * own figure read — the per-slice count catches a poll off the cadence's
 * rate), the run-level spacing pin catches a cadence-rate drift, and the
 * run-id chain check pins one id across the chat and its FINISH.
 *
 * Residuals, named here and never waived silently: header ORDER on the wire
 * is the runtime's, not the proxy's — a raw-TCP probe measures Bun's fetch
 * client serializing header names sorted with content-length appended last,
 * and Bun's server-side view re-sorts them fully on receipt, so the live
 * order check reads the stub's sorted recording against the capture's
 * sorted sequences and discriminates set membership; order deviations red
 * in the unit fixtures, which carry arbitrary order, and the order of the
 * header list the proxy passes to fetch is pinned structurally in the unit
 * leg. The capture's accept-encoding value is the relay runtime's own
 * default (the CLI leaves the header to its HTTP runtime) while the proxy
 * sets "gzip, deflate", so the pin keeps the client-set value; FINISH keeps
 * the legacy body the wire-drift doc names (the capture's carries a steps
 * array); the scenario's messages fixture fixes the live UTC date once per
 * run, so a chat across the UTC midnight boundary reads red; the cli class
 * and the login routes have no capture exchange, so their order pins the
 * capture's api-class base sequence with the class extras appended last,
 * the capture's own x-header placement.
 */

import { ADMISSION_PATH, AGENT_RUNS_PATH, CHAT_PATH, CLI_LOGIN_CODE_PATH, CLI_LOGIN_STATUS_PATH, MODELS_PATH, SESSION_PATH, STREAK_PATH } from "../src/transport.ts";

export type HeaderPair = [name: string, value: string];

export interface RecordedRequest {
  method: string;
  path: string;
  /** The raw query string, leading `?` included; absent reads as no query. */
  search?: string;
  headers: HeaderPair[];
  bodyRaw: string | null;
  at: number;
}

export type RequestClass =
  | "models"
  | "session-create"
  | "session-poll"
  | "session-end"
  | "admission"
  | "run-start"
  | "run-finish"
  | "chat"
  | "streak"
  | "login-code"
  | "login-status";

export type FindingKind = "missing-request" | "unexpected-request" | "header" | "body-field" | "cadence";

export interface ParityFinding {
  kind: FindingKind;
  scenario: string;
  request: string;
  detail: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_ID_RE = /^[0-9a-z]{10}$/;
const CLI_INSTANCE_RE = /^cli:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_RE = /^\d+$/;

/** The capture's user agents, pinned as literals here: a pin never reads the code under test. */
const CLASS_USER_AGENTS = {
  api: "Bun/1.3.14",
  chat: "ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser",
  cli: "Freebuff-CLI/0.2.34",
} as const;

const CLASS_OF: Record<RequestClass, keyof typeof CLASS_USER_AGENTS> = {
  models: "cli",
  "session-create": "cli",
  "session-poll": "cli",
  "session-end": "cli",
  admission: "cli",
  "run-start": "api",
  "run-finish": "api",
  chat: "chat",
  streak: "api",
  "login-code": "api",
  "login-status": "api",
};

/** The CLI's login routes answer before any account exists, so they carry no credential. */
const UNAUTHENTICATED: ReadonlySet<RequestClass> = new Set(["login-code", "login-status"]);

/** The capture's chat metadata descriptors, verbatim: the upstream has only
 * ever seen these exact strings from the official client. */
const CLI_CLIENT_ENV =
  "v1;in=1;out=1;tp=tmux;term=1;ct=1;sz=220x50;ci=0;ssh=0;l=0;p=shell;g=mux;osc=1;tzo=0;px=none;tls=1;ca=0;cde=none";
const CLI_INPUT_PROFILE = "v1;tc=0;ke=0;mc=0;pc=0;pe=0;cps=0";
const CLI_REPO_SNAPSHOT =
  '{"gitAvailable":true,"repositoryVisibility":"unknown","fileCount":1,"fileCountIsLowerBound":false,"testFileCount":0,"historyIsShallow":false,"changedFileCount":0,"changedFileScanTruncated":false}';

interface HeaderOrderEntry {
  name: string;
  /** The wire leaves this header out on some requests (measured optional upstream); it may sit out. */
  optional?: boolean;
}

function order(...names: string[]): HeaderOrderEntry[] {
  return names.map((name) => ({ name }));
}

/** The capture's per-class header sequence, names lowercased in the recorded
 * order (the recording relay serializes them sorted). Optional entries may
 * sit out; every required entry must ride. */
const API_POST_ORDER: HeaderOrderEntry[] = [
  ...order("accept", "accept-encoding", "authorization", "connection", "content-length"),
  { name: "content-type", optional: true },
  ...order("host", "user-agent"),
  { name: "x-freebuff-acting-user-id", optional: true },
];

const CLASS_HEADER_ORDER: Record<RequestClass, HeaderOrderEntry[]> = {
  models: order("accept", "accept-encoding", "authorization", "connection", "host", "user-agent", "x-freebuff-catalog-protocol"),
  "session-create": order("accept", "accept-encoding", "authorization", "connection", "host", "user-agent"),
  "session-poll": order("accept", "accept-encoding", "authorization", "connection", "host", "user-agent", "x-freebuff-instance-id"),
  "session-end": [
    ...order("accept", "accept-encoding", "authorization", "connection"),
    { name: "content-length", optional: true },
    ...order("host", "user-agent", "x-freebuff-instance-id"),
  ],
  admission: [
    ...order("accept", "accept-encoding", "authorization", "connection"),
    { name: "content-length", optional: true },
    ...order(
      "host",
      "user-agent",
      "x-freebuff-client",
      "x-freebuff-client-version",
      "x-freebuff-multi-session",
      "x-freebuff-purchase-continuity",
      "x-freebuff-desktop-attempt-id",
      "x-freebuff-instance-id",
      "x-freebuff-model",
      "x-freebuff-wallet-spend-limit",
      "x-freebuff-catalog-protocol",
    ),
    { name: "x-freebuff-catalog-fetch", optional: true },
  ],
  "run-start": API_POST_ORDER,
  "run-finish": API_POST_ORDER,
  chat: [
    ...order("accept", "accept-encoding", "authorization", "connection", "content-length", "content-type", "host", "user-agent"),
    { name: "x-freebuff-acting-user-id", optional: true },
    { name: "x-freebuff-catalog-fetch", optional: true },
    { name: "x-freebuff-device-key", optional: true },
    { name: "x-freebuff-device-sig", optional: true },
    { name: "x-freebuff-device-ts", optional: true },
    ...order("x-freebuff-sse-gzip-recovery"),
  ],
  streak: order("accept", "accept-encoding", "authorization", "connection", "host", "user-agent"),
  "login-code": order("accept", "accept-encoding", "connection", "content-length", "content-type", "host", "user-agent"),
  "login-status": order("accept", "accept-encoding", "connection", "host", "user-agent"),
};

export function requestClass(req: RecordedRequest): RequestClass | null {
  if (req.path === MODELS_PATH && req.method === "GET") return "models";
  if (req.path === SESSION_PATH) {
    if (req.method === "POST") return "session-create";
    if (req.method === "GET") return "session-poll";
    if (req.method === "DELETE") return "session-end";
    return null;
  }
  if (req.path === ADMISSION_PATH && req.method === "POST") return "admission";
  if (req.path === AGENT_RUNS_PATH && req.method === "POST") {
    const action = parseBody(req.bodyRaw)["action"];
    return action === "FINISH" ? "run-finish" : action === "START" ? "run-start" : null;
  }
  if (req.path === CHAT_PATH && req.method === "POST") return "chat";
  if (req.path === STREAK_PATH && req.method === "GET") return "streak";
  if (req.path === CLI_LOGIN_CODE_PATH && req.method === "POST") return "login-code";
  if (req.path === CLI_LOGIN_STATUS_PATH && req.method === "GET") return "login-status";
  return null;
}

export interface CompareContext {
  /** The account's freebuff token; every Bearer value must be exactly it. */
  token: string;
  /** The stub origin host[:port] the Host header must name. */
  host: string;
}

export interface ChatPins {
  /** The row's signed handle: the chat body's `model` field carries it. */
  model: string;
  stream: boolean;
  /** The exact messages container the chat must dial, every interpolated
   * value fixed by the fixture (the system opening's live date included). */
  messages: Array<Record<string, unknown>>;
  /** The client sent stop_sequences; the body must pass them through instead of the default. */
  stop?: string[];
  /** Top-level keys that must be absent (a dropped-when-absent mapping). */
  absentKeys?: string[];
  /** Extra top-level body fields, deep-compared against the converted wire. */
  fields?: Record<string, unknown>;
}

export interface ScenarioPins {
  /** Classes the scenario produces exactly once. */
  expect: RequestClass[];
  /** Classes that must not appear. */
  forbid?: RequestClass[];
  /** The agent id the run START must name (the free-catalog agent). */
  agentId?: string;
  /** The exact session-poll count the scenario's slice must hold. The
   * capture's chat exchanges dial no session wire; the harness driver aligns
   * each slice to the usage cadence's tick so the pin is exact. */
  pollCount: number;
  chat?: ChatPins;
}

function parseBody(raw: string | null): Record<string, unknown> {
  if (raw === null || raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function headerValue(req: RecordedRequest, name: string): string | null {
  const lower = name.toLowerCase();
  return req.headers.find(([key]) => key.toLowerCase() === lower)?.[1] ?? null;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function keySet(body: Record<string, unknown>, want: string[], at: (detail: string) => void): void {
  const got = Object.keys(body).sort();
  const wanted = [...want].sort();
  if (!sameJson(got, wanted)) at(`key set: want ${JSON.stringify(wanted)}, got ${JSON.stringify(got)}`);
}

function headerFindings(name: string, req: RecordedRequest, cls: RequestClass, pins: ScenarioPins, ctx: CompareContext): ParityFinding[] {
  const findings: ParityFinding[] = [];
  const where = `${cls} ${req.method} ${req.path}`;
  const at = (header: string, want: string, got: string | null): void => {
    findings.push({ kind: "header", scenario: name, request: where, detail: `${header}: want ${want}, got ${JSON.stringify(got)}` });
  };

  const pin = CLASS_HEADER_ORDER[cls];
  const pinNames = pin.map((entry) => entry.name);
  const recorded = req.headers.map(([header]) => header.toLowerCase());
  for (const header of recorded) {
    if (!pinNames.includes(header)) at(`header ${JSON.stringify(header)}`, `the capture's ${cls} set`, header);
  }
  // The recorded names in the capture's order: the walk may skip an optional
  // entry only, so a required header out of its place reds; a missing
  // required header reds in the value checks below.
  const projected = recorded.filter((header) => pinNames.includes(header));
  let pinIndex = 0;
  let ordered = true;
  for (const header of projected) {
    let matched = false;
    while (pinIndex < pin.length) {
      const entry = pin[pinIndex];
      if (entry === undefined) break;
      if (entry.name === header) {
        matched = true;
        pinIndex += 1;
        break;
      }
      if (entry.optional !== true) break;
      pinIndex += 1;
    }
    if (!matched) {
      ordered = false;
      break;
    }
  }
  if (!ordered) {
    at("header order", `the capture's [${pinNames.join(", ")}]`, `[${projected.join(", ")}]`);
  }

  // The runtime headers: content-length rides every body-carrying POST as
  // the body's exact UTF-8 byte count; the runtime's own "0" marker may ride
  // a bodiless request; a GET records none.
  const hasBody = req.method === "POST" && req.bodyRaw !== null && req.bodyRaw !== "";
  const contentLength = headerValue(req, "content-length");
  if (hasBody) {
    const bytes = new TextEncoder().encode(req.bodyRaw ?? "").length;
    if (contentLength === null || !DECIMAL_RE.test(contentLength)) {
      at("content-length", "a decimal byte count", contentLength);
    } else if (Number(contentLength) !== bytes) {
      at("content-length", `the body's ${bytes} bytes`, contentLength);
    }
  } else if (req.method === "GET") {
    if (contentLength !== null) at("content-length", "absent", contentLength);
  } else if (contentLength !== null && contentLength !== "0") {
    at("content-length", 'absent or "0" on a bodiless request', contentLength);
  }

  const want: Array<[string, string]> = [
    ["Accept", "*/*"],
    ["Accept-Encoding", "gzip, deflate"],
    ["Connection", "keep-alive"],
    ["Host", ctx.host],
    ...(UNAUTHENTICATED.has(cls) ? [] : ([["Authorization", `Bearer ${ctx.token}`]] as Array<[string, string]>)),
    ["User-Agent", CLASS_USER_AGENTS[CLASS_OF[cls]]],
  ];
  if (cls === "models") {
    want.push(["x-freebuff-catalog-protocol", "1"]);
  }
  if (cls === "chat") {
    want.push(["content-type", "application/json"], ["x-freebuff-sse-gzip-recovery", "1"]);
  }
  if (cls === "login-code") {
    want.push(["content-type", "application/json"]);
  }
  if (cls === "run-start" || cls === "run-finish") {
    // the capture's agent-runs exchange omits content-type while its other
    // api-class POSTs carry it; the value pins where the request carries one
    const got = headerValue(req, "content-type");
    if (got !== null && got !== "application/json") at("content-type", "application/json", got);
  }
  if (cls === "session-end") {
    // the sessionless wire mints its own instance id; a missing or
    // differently shaped one reds
    const got = headerValue(req, "x-freebuff-instance-id");
    if (got === null || !CLI_INSTANCE_RE.test(got)) {
      at("x-freebuff-instance-id", "a cli: uuid", got);
    }
  }
  if (cls === "session-poll") {
    const got = headerValue(req, "x-freebuff-instance-id");
    if (got === null || !CLI_INSTANCE_RE.test(got)) {
      at("x-freebuff-instance-id", "a cli: uuid", got);
    }
  }
  if (cls === "admission") {
    for (const [header, value] of [
      ["x-freebuff-client", "cli"],
      ["x-freebuff-client-version", "0.2.34"],
      ["x-freebuff-multi-session", "1"],
      ["x-freebuff-purchase-continuity", "1"],
      ["x-freebuff-wallet-spend-limit", "session"],
      ["x-freebuff-catalog-protocol", "1"],
    ] as Array<[string, string]>) {
      const got = headerValue(req, header);
      if (got !== value) at(header, JSON.stringify(value), got);
    }
    const attemptId = headerValue(req, "x-freebuff-desktop-attempt-id");
    if (attemptId === null || !UUID_RE.test(attemptId)) {
      at("x-freebuff-desktop-attempt-id", "the instance uuid without the cli: prefix", attemptId);
    }
    const instanceId = headerValue(req, "x-freebuff-instance-id");
    if (instanceId === null || !CLI_INSTANCE_RE.test(instanceId)) {
      at("x-freebuff-instance-id", "a cli: uuid", instanceId);
    }
    const model = headerValue(req, "x-freebuff-model");
    if (model === null || model === "") {
      at("x-freebuff-model", "the row's signed handle", model);
    }
    const fetch = headerValue(req, "x-freebuff-catalog-fetch");
    if (fetch !== null && fetch === "") {
      at("x-freebuff-catalog-fetch", "a non-empty fetch id when present", fetch);
    }
  }
  for (const [header, value] of want) {
    const got = headerValue(req, header);
    if (got !== value) at(header, JSON.stringify(value), got);
  }
  if (UNAUTHENTICATED.has(cls) && headerValue(req, "Authorization") !== null) {
    at("Authorization", "absent", headerValue(req, "Authorization"));
  }
  return findings;
}

function bodyFindings(name: string, req: RecordedRequest, cls: RequestClass, pins: ScenarioPins): ParityFinding[] {
  const findings: ParityFinding[] = [];
  const where = `${cls} ${req.method} ${req.path}`;
  const at = (detail: string): void => {
    findings.push({ kind: "body-field", scenario: name, request: where, detail });
  };
  const body = parseBody(req.bodyRaw);
  switch (cls) {
    case "models":
    case "session-poll":
    case "session-end":
    case "admission":
    case "streak": {
      if (req.bodyRaw !== null && req.bodyRaw !== "") at("this request carries no body");
      break;
    }
    case "login-code": {
      keySet(body, ["fingerprintId"], at);
      const fingerprintId = body["fingerprintId"];
      if (typeof fingerprintId !== "string" || fingerprintId === "") at(`fingerprintId: want a non-empty string, got ${JSON.stringify(fingerprintId ?? null)}`);
      break;
    }
    case "login-status": {
      if (req.bodyRaw !== null && req.bodyRaw !== "") at("this request carries no body");
      const query = new URLSearchParams(req.search ?? "");
      keySet(Object.fromEntries(query), ["fingerprintId", "fingerprintHash", "expiresAt"], at);
      for (const name of ["fingerprintId", "fingerprintHash"]) {
        const value = query.get(name);
        if (value === null || value === "") at(`${name}: want a non-empty query value, got ${JSON.stringify(value)}`);
      }
      const expiresAt = query.get("expiresAt");
      if (expiresAt === null || !/^\d+$/.test(expiresAt)) at(`expiresAt: want epoch milliseconds, got ${JSON.stringify(expiresAt)}`);
      break;
    }
    case "run-start": {
      keySet(body, ["action", "agentId", "ancestorRunIds"], at);
      if (body["action"] !== "START") at(`action: want "START", got ${JSON.stringify(body["action"] ?? null)}`);
      if (pins.agentId !== undefined && body["agentId"] !== pins.agentId) {
        at(`agentId: want ${JSON.stringify(pins.agentId)}, got ${JSON.stringify(body["agentId"] ?? null)}`);
      }
      if (!sameJson(body["ancestorRunIds"] ?? null, [])) at(`ancestorRunIds: want [], got ${JSON.stringify(body["ancestorRunIds"] ?? null)}`);
      break;
    }
    case "run-finish": {
      keySet(body, ["action", "runId", "status", "totalSteps", "directCredits", "totalCredits"], at);
      if (body["action"] !== "FINISH") at(`action: want "FINISH", got ${JSON.stringify(body["action"] ?? null)}`);
      if (body["status"] !== "completed") at(`status: want "completed", got ${JSON.stringify(body["status"] ?? null)}`);
      if (body["directCredits"] !== 0) at(`directCredits: want 0, got ${JSON.stringify(body["directCredits"] ?? null)}`);
      if (body["totalCredits"] !== 0) at(`totalCredits: want 0, got ${JSON.stringify(body["totalCredits"] ?? null)}`);
      if (typeof body["runId"] !== "string" || !UUID_RE.test(body["runId"])) {
        at(`runId: want a uuid, got ${JSON.stringify(body["runId"] ?? null)}`);
      }
      if (typeof body["totalSteps"] !== "number") at(`totalSteps: want a number, got ${JSON.stringify(body["totalSteps"] ?? null)}`);
      break;
    }
    case "chat": {
      findings.push(...chatBodyFindings(name, req, body, pins));
      break;
    }
  }
  return findings;
}

const CHAT_BASE_KEYS = ["model", "messages", "stream", "codebuff_metadata", "provider"];
const CHAT_OPTIONAL_KEYS = ["max_tokens", "temperature", "top_p", "stop", "tools", "tool_choice", "reasoning_effort", "parallel_tool_calls"];

function chatBodyFindings(name: string, req: RecordedRequest, body: Record<string, unknown>, pins: ScenarioPins): ParityFinding[] {
  const findings: ParityFinding[] = [];
  const where = `chat ${req.method} ${req.path}`;
  const at = (detail: string): void => {
    findings.push({ kind: "body-field", scenario: name, request: where, detail });
  };
  const chat = pins.chat;
  if (chat === undefined) {
    at("a chat request in a scenario without chat pins");
    return findings;
  }
  const allowed = new Set([...CHAT_BASE_KEYS, ...CHAT_OPTIONAL_KEYS]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) at(`unpinned chat body key ${JSON.stringify(key)}`);
  }
  for (const key of CHAT_BASE_KEYS) {
    if (!(key in body)) at(`missing chat body key ${JSON.stringify(key)}`);
  }
  for (const key of chat.absentKeys ?? []) {
    if (key in body) at(`${key}: want absent, got ${JSON.stringify(body[key] ?? null)}`);
  }
  if (body["model"] !== chat.model) at(`model: want ${JSON.stringify(chat.model)}, got ${JSON.stringify(body["model"] ?? null)}`);
  if (body["stream"] !== chat.stream) at(`stream: want ${JSON.stringify(chat.stream)}, got ${JSON.stringify(body["stream"] ?? null)}`);
  if (!sameJson(body["messages"] ?? null, chat.messages)) {
    at(`messages: want ${JSON.stringify(chat.messages)}, got ${JSON.stringify(body["messages"] ?? null)}`);
  }
  if (chat.stop === undefined) {
    if ("stop" in body) at(`stop: want absent, got ${JSON.stringify(body["stop"] ?? null)}`);
  } else if (!sameJson(body["stop"] ?? null, chat.stop)) {
    at(`stop: want ${JSON.stringify(chat.stop)}, got ${JSON.stringify(body["stop"] ?? null)}`);
  }
  if (!sameJson(body["provider"] ?? null, { data_collection: "deny" })) {
    at(`provider: want exactly {"data_collection":"deny"}, got ${JSON.stringify(body["provider"] ?? null)}`);
  }
  findings.push(...metadataFindings(name, req, body["codebuff_metadata"]));
  for (const [key, want] of Object.entries(chat.fields ?? {})) {
    if (!sameJson(body[key] ?? null, want)) at(`${key}: want ${JSON.stringify(want)}, got ${JSON.stringify(body[key] ?? null)}`);
  }
  return findings;
}

const CHAT_METADATA_KEYS = [
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
];

function metadataFindings(name: string, req: RecordedRequest, raw: unknown): ParityFinding[] {
  const findings: ParityFinding[] = [];
  const where = `chat ${req.method} ${req.path} codebuff_metadata`;
  const at = (detail: string): void => {
    findings.push({ kind: "body-field", scenario: name, request: where, detail });
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    at(`want an object, got ${JSON.stringify(raw ?? null)}`);
    return findings;
  }
  const meta = raw as Record<string, unknown>;
  keySet(meta, CHAT_METADATA_KEYS, at);
  if (meta["cost_mode"] !== "free") at(`cost_mode: want "free", got ${JSON.stringify(meta["cost_mode"] ?? null)}`);
  if (meta["freebuff_multi_session"] !== "1") at(`freebuff_multi_session: want "1", got ${JSON.stringify(meta["freebuff_multi_session"] ?? null)}`);
  if (meta["surface"] !== "cli") at(`surface: want "cli", got ${JSON.stringify(meta["surface"] ?? null)}`);
  if (meta["llm_step_number"] !== "1") at(`llm_step_number: want "1", got ${JSON.stringify(meta["llm_step_number"] ?? null)}`);
  if (meta["freebuff_client_env"] !== CLI_CLIENT_ENV) {
    at(`freebuff_client_env: want the capture's descriptor ${JSON.stringify(CLI_CLIENT_ENV)}, got ${JSON.stringify(meta["freebuff_client_env"] ?? null)}`);
  }
  if (meta["freebuff_input_profile"] !== CLI_INPUT_PROFILE) {
    at(`freebuff_input_profile: want the capture's descriptor ${JSON.stringify(CLI_INPUT_PROFILE)}, got ${JSON.stringify(meta["freebuff_input_profile"] ?? null)}`);
  }
  if (meta["repo_snapshot"] !== CLI_REPO_SNAPSHOT) {
    at(`repo_snapshot: want the capture's snapshot ${JSON.stringify(CLI_REPO_SNAPSHOT)}, got ${JSON.stringify(meta["repo_snapshot"] ?? null)}`);
  }
  const clientId = meta["client_id"];
  if (typeof clientId !== "string" || !CLIENT_ID_RE.test(clientId)) {
    at(`client_id: want 10 base-36 chars, got ${JSON.stringify(clientId ?? null)}`);
  }
  const trace = meta["trace_session_id"];
  if (typeof trace !== "string" || !UUID_RE.test(trace)) {
    at(`trace_session_id: want a uuid, got ${JSON.stringify(trace ?? null)}`);
  }
  const runId = meta["run_id"];
  if (typeof runId !== "string" || !UUID_RE.test(runId)) {
    at(`run_id: want a uuid, got ${JSON.stringify(runId ?? null)}`);
  }
  const instanceId = meta["freebuff_instance_id"];
  if (typeof instanceId !== "string" || !CLI_INSTANCE_RE.test(instanceId)) {
    at(`freebuff_instance_id: want a cli: uuid, got ${JSON.stringify(instanceId ?? null)}`);
  }
  return findings;
}

/** One scenario's comparison: every recorded request shape-checked against
 * its class's pins, every expected class present exactly once, every
 * forbidden (and unclassifiable) dial named, and the session-poll count
 * exactly the pin. */
export function compareScenario(name: string, reqs: RecordedRequest[], pins: ScenarioPins, ctx: CompareContext): ParityFinding[] {
  const findings: ParityFinding[] = [];
  const classified = reqs.map((req) => ({ req, cls: requestClass(req) }));
  for (const { req, cls } of classified) {
    if (cls === null) {
      findings.push({ kind: "unexpected-request", scenario: name, request: `${req.method} ${req.path}`, detail: "no class in the brief's request set" });
      continue;
    }
    if (pins.forbid?.includes(cls)) {
      findings.push({ kind: "unexpected-request", scenario: name, request: `${req.method} ${req.path}`, detail: `${cls} is forbidden in this scenario` });
      continue;
    }
    findings.push(...headerFindings(name, req, cls, pins, ctx));
    findings.push(...bodyFindings(name, req, cls, pins));
  }
  for (const cls of pins.expect) {
    const count = classified.filter(({ cls: seen }) => seen === cls).length;
    if (count !== 1) {
      findings.push({ kind: "missing-request", scenario: name, request: cls, detail: `expected exactly 1, saw ${count}` });
    }
  }
  const polls = classified.filter(({ cls }) => cls === "session-poll").length;
  if (polls !== pins.pollCount) {
    findings.push({ kind: "missing-request", scenario: name, request: "session-poll", detail: `expected exactly ${pins.pollCount}, saw ${polls}` });
  }

  // The run-id chain: the one id the START answered rides the chat's
  // metadata and its FINISH — the capture carries one id across all three.
  const chatRunIds: string[] = [];
  const finishRunIds: string[] = [];
  for (const { req, cls } of classified) {
    const body = parseBody(req.bodyRaw);
    if (cls === "chat") {
      const raw = body["codebuff_metadata"];
      const meta = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      const runId = meta["run_id"];
      if (typeof runId === "string") chatRunIds.push(runId);
    } else if (cls === "run-finish") {
      const runId = body["runId"];
      if (typeof runId === "string") finishRunIds.push(runId);
    }
  }
  for (const chatRunId of chatRunIds) {
    if (finishRunIds.length > 0 && !finishRunIds.includes(chatRunId)) {
      findings.push({
        kind: "body-field",
        scenario: name,
        request: "the run-id chain",
        detail: `the chat's run_id ${JSON.stringify(chatRunId)} does not match the FINISH runId ${JSON.stringify(finishRunIds[0] ?? null)}`,
      });
    }
  }
  return findings;
}

const POLL_GAP_MIN_MS = 900;
const POLL_GAP_MAX_MS = 1100;

/** The usage cadence's poll spacing across a run: every consecutive gap
 * between session polls must sit inside [900, 1100] ms (the core's
 * usage_cadence_ms of 1000, pinned as a literal). Slice-independent: the
 * polls come off the full recorded log, so a cadence-rate drift reds no
 * matter how the scenario slices are bracketed. */
export function comparePollSpacing(name: string, polls: RecordedRequest[]): ParityFinding[] {
  const findings: ParityFinding[] = [];
  for (let i = 1; i < polls.length; i++) {
    const gap = polls[i]!.at - polls[i - 1]!.at;
    if (gap < POLL_GAP_MIN_MS || gap > POLL_GAP_MAX_MS) {
      findings.push({
        kind: "cadence",
        scenario: name,
        request: "session-poll spacing",
        detail: `gap ${gap} ms between consecutive polls: want within [${POLL_GAP_MIN_MS}, ${POLL_GAP_MAX_MS}]`,
      });
    }
  }
  return findings;
}
