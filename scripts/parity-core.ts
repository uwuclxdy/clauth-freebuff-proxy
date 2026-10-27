/**
 * The wire-parity comparator's pure core. The proxy's recorded upstream
 * requests compare against the shapes the protocol brief pins
 * (docs/research/freebuff-protocol-2026-10-26/brief.md rows c/d/e/f — the
 * brief is the parity reference, not a live client: the CLI ships its
 * protocol in a compiled binary, brief §sources). Each request classifies by
 * method + path (+ body action for the agent-runs pair); each class pins its
 * header set — the base six with the per-class user agent row f fixes, cli
 * for the session wire (row c), api for the client chain (row e), chat for
 * the completions wire — and its body's exact key set with volatile values
 * (token, client_id, trace_session_id, run ids) classed by shape.
 *
 * Residuals, named here and never waived silently: headers the brief leaves
 * to the runtime (content-type, content-length and their kin) are recorded
 * but never demanded; header order is not compared (the brief pins a set);
 * the chat body's `messages` array compares as a container only — the
 * conversion's own mapping is convert.test.ts's domain; and `session-poll`
 * is timing-owned — the usage cadence produces polls independently of any
 * scenario, so their count never compares, their shape still does.
 */

import { AGENT_RUNS_PATH, CHAT_PATH, SESSION_PATH, STREAK_PATH } from "../src/transport.ts";

export type HeaderPair = [name: string, value: string];

export interface RecordedRequest {
  method: string;
  path: string;
  headers: HeaderPair[];
  bodyRaw: string | null;
  at: number;
}

export type RequestClass =
  | "session-create"
  | "session-poll"
  | "session-end"
  | "run-start"
  | "run-finish"
  | "chat"
  | "streak";

export type FindingKind = "missing-request" | "unexpected-request" | "header" | "body-field";

export interface ParityFinding {
  kind: FindingKind;
  scenario: string;
  request: string;
  detail: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_ID_RE = /^[0-9a-z]{13}$/;

/** Row f's user agents, pinned as literals here: a pin never reads the code under test. */
const CLASS_USER_AGENTS = {
  api: "Bun/1.3.11",
  chat: "ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.20 runtime/browser",
  cli: "Freebuff-CLI/0.0.105",
} as const;

const CLASS_OF: Record<RequestClass, keyof typeof CLASS_USER_AGENTS> = {
  "session-create": "cli",
  "session-poll": "cli",
  "session-end": "cli",
  "run-start": "api",
  "run-finish": "api",
  chat: "chat",
  streak: "api",
};

export function requestClass(req: RecordedRequest): RequestClass | null {
  if (req.path === SESSION_PATH) {
    if (req.method === "POST") return "session-create";
    if (req.method === "GET") return "session-poll";
    if (req.method === "DELETE") return "session-end";
    return null;
  }
  if (req.path === AGENT_RUNS_PATH && req.method === "POST") {
    const action = parseBody(req.bodyRaw)["action"];
    return action === "FINISH" ? "run-finish" : action === "START" ? "run-start" : null;
  }
  if (req.path === CHAT_PATH && req.method === "POST") return "chat";
  if (req.path === STREAK_PATH && req.method === "GET") return "streak";
  return null;
}

export interface CompareContext {
  /** The account's freebuff token; every Bearer value must be exactly it. */
  token: string;
  /** The stub origin host[:port] the Host header must name. */
  host: string;
  /** The stub's session instance id. */
  instanceId: string;
}

export interface ChatPins {
  model: string;
  stream: boolean;
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
  /** The agent id the run START must name (the model table's row for the requested model). */
  agentId?: string;
  /** The canonical model the session create must steer. */
  sessionModel?: string;
  /** A session instance rides the chat metadata and the poll/end headers. */
  sessionLive: boolean;
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
  const want: Array<[string, string]> = [
    ["Accept", "*/*"],
    ["Accept-Encoding", "gzip, deflate"],
    ["Connection", "keep-alive"],
    ["Host", ctx.host],
    ["Authorization", `Bearer ${ctx.token}`],
    ["User-Agent", CLASS_USER_AGENTS[CLASS_OF[cls]]],
  ];
  if (cls === "session-create") {
    if (pins.sessionModel === undefined) throw new Error("parity: a session-create pin needs the scenario's sessionModel");
    want.push(["x-freebuff-model", pins.sessionModel]);
  }
  if (cls === "session-end") {
    want.push(["x-freebuff-instance-id", ctx.instanceId]);
  }
  for (const [header, value] of want) {
    const got = headerValue(req, header);
    if (got !== value) at(header, JSON.stringify(value), got);
  }
  if (cls === "session-poll") {
    // presence is timing-owned (a poll can race the first session create);
    // a wrong id still reds
    const got = headerValue(req, "x-freebuff-instance-id");
    if (got !== null && got !== ctx.instanceId) at("x-freebuff-instance-id", `${JSON.stringify(ctx.instanceId)} when present`, got);
  }
  return findings;
}

function bodyFindings(name: string, req: RecordedRequest, cls: RequestClass, pins: ScenarioPins, ctx: CompareContext): ParityFinding[] {
  const findings: ParityFinding[] = [];
  const where = `${cls} ${req.method} ${req.path}`;
  const at = (detail: string): void => {
    findings.push({ kind: "body-field", scenario: name, request: where, detail });
  };
  const body = parseBody(req.bodyRaw);
  switch (cls) {
    case "session-create": {
      keySet(body, [], at);
      break;
    }
    case "session-poll":
    case "session-end":
    case "streak": {
      if (req.bodyRaw !== null && req.bodyRaw !== "") at("this request carries no body");
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
      if (typeof body["runId"] !== "string" || body["runId"] === "") at(`runId: want a non-empty string, got ${JSON.stringify(body["runId"] ?? null)}`);
      if (typeof body["totalSteps"] !== "number") at(`totalSteps: want a number, got ${JSON.stringify(body["totalSteps"] ?? null)}`);
      break;
    }
    case "chat": {
      findings.push(...chatBodyFindings(name, req, body, pins, ctx));
      break;
    }
  }
  return findings;
}

const CHAT_BASE_KEYS = ["model", "messages", "stream", "codebuff_metadata", "provider"];
const CHAT_OPTIONAL_KEYS = ["max_tokens", "temperature", "top_p", "stop", "tools", "tool_choice", "reasoning_effort", "parallel_tool_calls"];

function chatBodyFindings(name: string, req: RecordedRequest, body: Record<string, unknown>, pins: ScenarioPins, ctx: CompareContext): ParityFinding[] {
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
  if (!Array.isArray(body["messages"])) at(`messages: want an array, got ${JSON.stringify(body["messages"] ?? null)}`);
  const wantStop = chat.stop ?? ["cb_easp"];
  if (!sameJson(body["stop"] ?? null, wantStop)) at(`stop: want ${JSON.stringify(wantStop)}, got ${JSON.stringify(body["stop"] ?? null)}`);
  if (!sameJson(body["provider"] ?? null, { data_collection: "deny" })) {
    at(`provider: want exactly {"data_collection":"deny"}, got ${JSON.stringify(body["provider"] ?? null)}`);
  }
  findings.push(...metadataFindings(name, req, body["codebuff_metadata"], pins, ctx));
  for (const [key, want] of Object.entries(chat.fields ?? {})) {
    if (!sameJson(body[key] ?? null, want)) at(`${key}: want ${JSON.stringify(want)}, got ${JSON.stringify(body[key] ?? null)}`);
  }
  return findings;
}

function metadataFindings(name: string, req: RecordedRequest, raw: unknown, pins: ScenarioPins, ctx: CompareContext): ParityFinding[] {
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
  const wantKeys = pins.sessionLive
    ? ["client_id", "cost_mode", "freebuff_instance_id", "run_id", "trace_session_id"]
    : ["client_id", "cost_mode", "run_id", "trace_session_id"];
  keySet(meta, wantKeys, at);
  if (meta["cost_mode"] !== "free") at(`cost_mode: want "free", got ${JSON.stringify(meta["cost_mode"] ?? null)}`);
  const clientId = meta["client_id"];
  if (typeof clientId !== "string" || !CLIENT_ID_RE.test(clientId)) {
    at(`client_id: want 13 base-36 chars, got ${JSON.stringify(clientId ?? null)}`);
  }
  const trace = meta["trace_session_id"];
  if (typeof trace !== "string" || !UUID_RE.test(trace)) {
    at(`trace_session_id: want a uuid, got ${JSON.stringify(trace ?? null)}`);
  }
  if (typeof meta["run_id"] !== "string" || meta["run_id"] === "") {
    at(`run_id: want a non-empty string, got ${JSON.stringify(meta["run_id"] ?? null)}`);
  }
  if (pins.sessionLive && meta["freebuff_instance_id"] !== ctx.instanceId) {
    at(`freebuff_instance_id: want ${JSON.stringify(ctx.instanceId)}, got ${JSON.stringify(meta["freebuff_instance_id"] ?? null)}`);
  }
  return findings;
}

/** One scenario's comparison: every recorded request shape-checked against
 * its class's pins, every expected class present exactly once, every
 * forbidden (and unclassifiable) dial named. */
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
    findings.push(...bodyFindings(name, req, cls, pins, ctx));
  }
  for (const cls of pins.expect) {
    const count = classified.filter(({ cls: seen }) => seen === cls).length;
    if (count !== 1) {
      findings.push({ kind: "missing-request", scenario: name, request: cls, detail: `expected exactly 1, saw ${count}` });
    }
  }
  return findings;
}
