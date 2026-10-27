import { describe, expect, test } from "bun:test";
import { compareScenario, requestClass, type CompareContext, type HeaderPair, type RecordedRequest, type ScenarioPins } from "../scripts/parity-core.ts";

// The rows are hand-pinned from the protocol brief (rows c/d/e/f): the header
// sets, the body key sets and the volatile shapes — never produced by the code
// under test, or a shared bug would stay green forever.

const TOKEN = "fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7";
const INSTANCE = "inst-1";
const MODEL = "minimax/minimax-m2.7";
const AGENT = "base2-free";
const CHAT_UA = "ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.20 runtime/browser";
const CLI_UA = "Freebuff-CLI/0.0.105";
const API_UA = "Bun/1.3.11";

const CTX: CompareContext = { token: TOKEN, host: "127.0.0.1:9", instanceId: INSTANCE };

function req(method: string, path: string, headers: Array<[string, string]>, bodyRaw: string | null = null, search = ""): RecordedRequest {
  return { method, path, search, headers, bodyRaw, at: 0 };
}

function baseHeaders(userAgent: string): Array<[string, string]> {
  return [
    ["Accept", "*/*"],
    ["Accept-Encoding", "gzip, deflate"],
    ["Connection", "keep-alive"],
    ["Host", "127.0.0.1:9"],
    ["User-Agent", userAgent],
    ["Authorization", `Bearer ${TOKEN}`],
  ];
}

function chatMetadata(sessionLive: boolean): Record<string, unknown> {
  return {
    run_id: "run-1",
    client_id: "abc123def9012",
    trace_session_id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    cost_mode: "free",
    ...(sessionLive ? { freebuff_instance_id: INSTANCE } : {}),
  };
}

function chatRow(body: Record<string, unknown>, metadata = chatMetadata(true)): RecordedRequest {
  const bodyRaw = JSON.stringify({
    model: MODEL,
    messages: [],
    stream: false,
    codebuff_metadata: metadata,
    provider: { data_collection: "deny" },
    stop: ["cb_easp"],
    ...body,
  });
  return req("POST", "/api/v1/chat/completions", [...baseHeaders(CHAT_UA), ["Content-Type", "application/json"]], bodyRaw);
}

const FULL_PINS: ScenarioPins = {
  expect: ["session-create", "run-start", "chat", "run-finish"],
  agentId: AGENT,
  sessionModel: MODEL,
  sessionLive: true,
  chat: { model: MODEL, stream: false },
};

function conformingSlice(): RecordedRequest[] {
  return [
    req("POST", "/api/v1/freebuff/session", [...baseHeaders(CLI_UA), ["x-freebuff-model", MODEL], ["Content-Type", "application/json"]], "{}"),
    req("POST", "/api/v1/agent-runs", [...baseHeaders(API_UA), ["Content-Type", "application/json"]], JSON.stringify({ action: "START", agentId: AGENT, ancestorRunIds: [] })),
    chatRow({}),
    req("POST", "/api/v1/agent-runs", [...baseHeaders(API_UA), ["Content-Type", "application/json"]], JSON.stringify({ action: "FINISH", runId: "run-1", status: "completed", totalSteps: 0, directCredits: 0, totalCredits: 0 })),
  ];
}

describe("requestClass", () => {
  test("the agent-runs pair splits by body action; unknown paths class null", () => {
    expect(requestClass(conformingSlice()[1]!)).toBe("run-start");
    expect(requestClass(conformingSlice()[3]!)).toBe("run-finish");
    expect(requestClass(req("POST", "/api/v1/ads", [], "{}"))).toBeNull();
    expect(requestClass(req("POST", "/api/v1/agent-runs", [], JSON.stringify({ action: "OTHER" })))).toBeNull();
  });
});

const LOGIN_HASH = "d".repeat(64);
const LOGIN_QUERY = `?fingerprintId=clauth-freebuff-proxy-abc&fingerprintHash=${LOGIN_HASH}&expiresAt=1793094251375`;

function unauthenticated(userAgent: string, withContentType = false): Array<[string, string]> {
  return [
    ...baseHeaders(userAgent).filter(([name]) => name !== "Authorization"),
    ...(withContentType ? ([["Content-Type", "application/json"]] as Array<[string, string]>) : []),
  ];
}

function loginSlice(query = LOGIN_QUERY): RecordedRequest[] {
  return [
    req("POST", "/api/auth/cli/code", unauthenticated(API_UA, true), JSON.stringify({ fingerprintId: "clauth-freebuff-proxy-abc" })),
    req("GET", "/api/auth/cli/status", unauthenticated(API_UA), null, query),
  ];
}

const LOGIN_PINS: ScenarioPins = { expect: ["login-code", "login-status"], sessionLive: false };

describe("the login wire", () => {
  test("the CLI's code and status requests classify without a credential and pin their shapes", () => {
    expect(requestClass(loginSlice()[0]!)).toBe("login-code");
    expect(requestClass(loginSlice()[1]!)).toBe("login-status");
    expect(compareScenario("login", loginSlice(), LOGIN_PINS, CTX)).toEqual([]);
  });

  test("a login request carrying a credential reds", () => {
    const slice = loginSlice();
    slice[1] = { ...slice[1]!, headers: baseHeaders(API_UA) };
    const findings = compareScenario("login", slice, LOGIN_PINS, CTX);
    expect(findings.map((finding) => finding.detail).join("\n")).toContain("Authorization");
  });

  test("a status poll missing its fingerprint hash reds", () => {
    const findings = compareScenario("login", loginSlice("?fingerprintId=abc&expiresAt=1"), LOGIN_PINS, CTX);
    expect(findings.some((finding) => finding.detail.includes("fingerprintHash"))).toBe(true);
  });

  test("a status poll with an extra key, an empty value or a non-numeric expiry reds", () => {
    const extra = compareScenario("login", loginSlice(`${LOGIN_QUERY}&extra=1`), LOGIN_PINS, CTX);
    expect(extra.some((finding) => finding.detail.includes("key set"))).toBe(true);

    const empty = compareScenario("login", loginSlice("?fingerprintId=&fingerprintHash=&expiresAt=1"), LOGIN_PINS, CTX);
    expect(empty.some((finding) => finding.detail.includes("fingerprintId"))).toBe(true);

    const badExpiry = compareScenario("login", loginSlice(LOGIN_QUERY.replace("expiresAt=1793094251375", "expiresAt=soon")), LOGIN_PINS, CTX);
    expect(badExpiry.some((finding) => finding.detail.includes("expiresAt"))).toBe(true);
  });
});

describe("compareScenario", () => {
  test("a conforming slice produces no findings", () => {
    expect(compareScenario("conforming", conformingSlice(), FULL_PINS, CTX)).toEqual([]);
  });

  test("a dropped class is one missing-request finding naming it", () => {
    const slice = conformingSlice().slice(0, 3);
    const findings = compareScenario("dropped", slice, FULL_PINS, CTX);
    expect(findings).toEqual([{ kind: "missing-request", scenario: "dropped", request: "run-finish", detail: "expected exactly 1, saw 0" }]);
  });

  test("a dial outside the brief's request set is unexpected-request", () => {
    const findings = compareScenario("ads", [...conformingSlice(), req("POST", "/api/v1/ads", [], "{}")], FULL_PINS, CTX);
    expect(findings).toEqual([{ kind: "unexpected-request", scenario: "ads", request: "POST /api/v1/ads", detail: "no class in the brief's request set" }]);
  });

  test("a wrong user agent is one header finding", () => {
    const slice = conformingSlice();
    slice[2] = chatRow({}, chatMetadata(true));
    slice[2] = { ...slice[2]!, headers: [...baseHeaders("Bun/1.3.11"), ["Content-Type", "application/json"]] };
    const findings = compareScenario("ua", slice, FULL_PINS, CTX);
    expect(findings).toEqual([
      { kind: "header", scenario: "ua", request: "chat POST /api/v1/chat/completions", detail: 'User-Agent: want "ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.20 runtime/browser", got "Bun/1.3.11"' },
    ]);
  });

  test("a foreign bearer token is one header finding", () => {
    const slice = conformingSlice();
    slice[0] = {
      ...slice[0]!,
      headers: [...baseHeaders(CLI_UA).map(([name, value]): HeaderPair => (name === "Authorization" ? ["Authorization", "Bearer other-token"] : [name, value])), ["x-freebuff-model", MODEL]],
    };
    const findings = compareScenario("bearer", slice, FULL_PINS, CTX);
    expect(findings).toEqual([
      { kind: "header", scenario: "bearer", request: "session-create POST /api/v1/freebuff/session", detail: 'Authorization: want "Bearer fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7", got "Bearer other-token"' },
    ]);
  });

  test("a session create without the model header reds; the body must be {}", () => {
    const slice = conformingSlice();
    slice[0] = { ...slice[0]!, headers: [...baseHeaders(CLI_UA)] };
    const findings = compareScenario("no-model-header", slice, FULL_PINS, CTX);
    expect(findings).toEqual([
      { kind: "header", scenario: "no-model-header", request: "session-create POST /api/v1/freebuff/session", detail: 'x-freebuff-model: want "minimax/minimax-m2.7", got null' },
    ]);

    const wrongBody = conformingSlice();
    wrongBody[0] = req("POST", "/api/v1/freebuff/session", [...baseHeaders(CLI_UA), ["x-freebuff-model", MODEL]], JSON.stringify({ countryCode: "XX" }));
    expect(compareScenario("body", wrongBody, FULL_PINS, CTX)).toEqual([
      { kind: "body-field", scenario: "body", request: "session-create POST /api/v1/freebuff/session", detail: 'key set: want [], got ["countryCode"]' },
    ]);
  });

  test("an extra metadata key reds; the session id rides only when a session is live", () => {
    const withExtra = chatRow({}, { ...chatMetadata(true), extra: 1 });
    const findings = compareScenario("extra-key", [withExtra], { ...FULL_PINS, expect: ["chat"] }, CTX);
    expect(findings).toEqual([
      { kind: "body-field", scenario: "extra-key", request: "chat POST /api/v1/chat/completions codebuff_metadata", detail: 'key set: want ["client_id","cost_mode","freebuff_instance_id","run_id","trace_session_id"], got ["client_id","cost_mode","extra","freebuff_instance_id","run_id","trace_session_id"]' },
    ]);

    const sessionlessSlice = conformingSlice();
    sessionlessSlice[2] = chatRow({}, chatMetadata(false));
    expect(compareScenario("sessionless", sessionlessSlice, { ...FULL_PINS, sessionLive: false }, CTX)).toEqual([]);
  });

  test("volatile metadata shapes class: a 12-char client_id and a non-uuid trace red", () => {
    const slice = conformingSlice();
    slice[2] = chatRow({}, { ...chatMetadata(true), client_id: "short", trace_session_id: "not-a-uuid" });
    const findings = compareScenario("shapes", slice, FULL_PINS, CTX);
    expect(findings.map((finding) => finding.detail)).toEqual([
      'client_id: want 13 base-36 chars, got "short"',
      'trace_session_id: want a uuid, got "not-a-uuid"',
    ]);
  });

  test("a client stop replaces the cb_easp default; a missing default reds", () => {
    const pinned = conformingSlice();
    pinned[2] = chatRow({ stop: ["END"] });
    expect(compareScenario("stop", pinned, { ...FULL_PINS, chat: { model: MODEL, stream: false, stop: ["END"] } }, CTX)).toEqual([]);

    const droppedRow = chatRow({});
    const droppedBody = JSON.parse(droppedRow.bodyRaw!) as Record<string, unknown>;
    delete droppedBody["stop"];
    const dropped = conformingSlice();
    dropped[2] = req("POST", "/api/v1/chat/completions", [...baseHeaders(CHAT_UA), ["Content-Type", "application/json"]], JSON.stringify(droppedBody));
    const findings = compareScenario("no-stop", dropped, FULL_PINS, CTX);
    expect(findings).toEqual([
      { kind: "body-field", scenario: "no-stop", request: "chat POST /api/v1/chat/completions", detail: 'stop: want ["cb_easp"], got null' },
    ]);
  });

  test("a nonzero credit on the FINISH reds", () => {
    const slice = conformingSlice();
    slice[3] = req("POST", "/api/v1/agent-runs", baseHeaders(API_UA), JSON.stringify({ action: "FINISH", runId: "run-1", status: "completed", totalSteps: 0, directCredits: 0, totalCredits: 5 }));
    const findings = compareScenario("credits", slice, FULL_PINS, CTX);
    expect(findings).toEqual([
      { kind: "body-field", scenario: "credits", request: "run-finish POST /api/v1/agent-runs", detail: "totalCredits: want 0, got 5" },
    ]);
  });

  test("session polls are timing-owned: any count, wrong instance id still reds", () => {
    const poll = (): RecordedRequest => req("GET", "/api/v1/freebuff/session", [...baseHeaders(CLI_UA), ["x-freebuff-instance-id", INSTANCE]]);
    const slice = [...conformingSlice(), poll(), poll()];
    expect(compareScenario("polls", slice, FULL_PINS, CTX)).toEqual([]);

    const wrong = [...conformingSlice(), req("GET", "/api/v1/freebuff/session", [...baseHeaders(CLI_UA), ["x-freebuff-instance-id", "inst-other"]])];
    const findings = compareScenario("wrong-instance", wrong, FULL_PINS, CTX);
    expect(findings).toEqual([
      { kind: "header", scenario: "wrong-instance", request: "session-poll GET /api/v1/freebuff/session", detail: 'x-freebuff-instance-id: want "inst-1" when present, got "inst-other"' },
    ]);
  });
});
