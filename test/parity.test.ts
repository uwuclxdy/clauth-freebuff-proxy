import { describe, expect, test } from "bun:test";
import { compareScenario, requestClass, type CompareContext, type HeaderPair, type RecordedRequest, type ScenarioPins } from "../scripts/parity-core.ts";

// The rows are hand-pinned from the 2026-10-27 live-drift capture: the
// header sets, the body key sets and the volatile shapes — never produced by
// the code under test, or a shared bug would stay green forever.

const TOKEN = "fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7";
const INSTANCE = "cli:11111111-2222-4333-8444-555555555555";
const KEY = "m-0000000001";
const HANDLE = "fbm1.stub.aaaa";
const AGENT = "base3-free-catalog";
const CHAT_UA = "ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser";
const CLI_UA = "Freebuff-CLI/0.2.34";
const API_UA = "Bun/1.3.14";

const CTX: CompareContext = { token: TOKEN, host: "127.0.0.1:9", instanceId: "inst-1" };

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

function chatMetadata(): Record<string, unknown> {
  return {
    run_id: "run-1",
    client_id: "abc123def9",
    trace_session_id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    cost_mode: "free",
    freebuff_instance_id: INSTANCE,
    freebuff_multi_session: "1",
    surface: "cli",
    freebuff_client_env: "v1;in=1",
    freebuff_input_profile: "v1;tc=0",
    repo_snapshot: '{"gitAvailable":true}',
    llm_step_number: "1",
  };
}

function chatRow(body: Record<string, unknown> = {}, metadata = chatMetadata()): RecordedRequest {
  const bodyRaw = JSON.stringify({
    model: HANDLE,
    messages: [],
    stream: false,
    codebuff_metadata: metadata,
    provider: { data_collection: "deny" },
    ...body,
  });
  return req("POST", "/api/v1/chat/completions", [...baseHeaders(CHAT_UA), ["Content-Type", "application/json"]], bodyRaw);
}

const FULL_PINS: ScenarioPins = {
  expect: ["models", "run-start", "chat", "run-finish"],
  agentId: AGENT,
  sessionLive: true,
  chat: { model: HANDLE, stream: false },
};

function conformingSlice(): RecordedRequest[] {
  return [
    req("GET", "/api/v1/freebuff/models", [...baseHeaders(CLI_UA), ["x-freebuff-catalog-protocol", "1"]]),
    req("POST", "/api/v1/agent-runs", [...baseHeaders(API_UA), ["Content-Type", "application/json"]], JSON.stringify({ action: "START", agentId: AGENT, ancestorRunIds: [] })),
    chatRow(),
    req("POST", "/api/v1/agent-runs", [...baseHeaders(API_UA), ["Content-Type", "application/json"]], JSON.stringify({ action: "FINISH", runId: "run-1", status: "completed", totalSteps: 0, directCredits: 0, totalCredits: 0 })),
  ];
}

describe("requestClass", () => {
  test("the models GET, the agent-runs pair and the chat classify; unknown paths class null", () => {
    expect(requestClass(conformingSlice()[0]!)).toBe("models");
    expect(requestClass(conformingSlice()[1]!)).toBe("run-start");
    expect(requestClass(conformingSlice()[2]!)).toBe("chat");
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
    slice[2] = { ...slice[2]!, headers: [...baseHeaders("Bun/1.3.14"), ["Content-Type", "application/json"]] };
    const findings = compareScenario("ua", slice, FULL_PINS, CTX);
    expect(findings).toEqual([
      { kind: "header", scenario: "ua", request: "chat POST /api/v1/chat/completions", detail: 'User-Agent: want "ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser", got "Bun/1.3.14"' },
    ]);
  });

  test("a models GET without the catalog-protocol header reds", () => {
    const slice = conformingSlice();
    slice[0] = { ...slice[0]!, headers: baseHeaders(CLI_UA) };
    const findings = compareScenario("no-catalog-header", slice, FULL_PINS, CTX);
    expect(findings).toEqual([
      { kind: "header", scenario: "no-catalog-header", request: "models GET /api/v1/freebuff/models", detail: 'x-freebuff-catalog-protocol: want "1", got null' },
    ]);
  });

  test("a foreign bearer token is one header finding", () => {
    const slice = conformingSlice();
    slice[0] = {
      ...slice[0]!,
      headers: [...baseHeaders(CLI_UA).map(([name, value]): HeaderPair => (name === "Authorization" ? ["Authorization", "Bearer other-token"] : [name, value])), ["x-freebuff-catalog-protocol", "1"]],
    };
    const findings = compareScenario("bearer", slice, FULL_PINS, CTX);
    expect(findings).toEqual([
      { kind: "header", scenario: "bearer", request: "models GET /api/v1/freebuff/models", detail: 'Authorization: want "Bearer fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7", got "Bearer other-token"' },
    ]);
  });

  test("a session create without the model header reds; the body must be {}", () => {
    const create = req("POST", "/api/v1/freebuff/session", [...baseHeaders(CLI_UA)], JSON.stringify({}));
    const findings = compareScenario("no-model-header", [create], { expect: ["session-create"], sessionModel: KEY, sessionLive: false }, CTX);
    expect(findings).toEqual([
      { kind: "header", scenario: "no-model-header", request: "session-create POST /api/v1/freebuff/session", detail: `x-freebuff-model: want "${KEY}", got null` },
    ]);

    const wrongBody = req("POST", "/api/v1/freebuff/session", [...baseHeaders(CLI_UA), ["x-freebuff-model", KEY]], JSON.stringify({ countryCode: "XX" }));
    expect(compareScenario("body", [wrongBody], { expect: ["session-create"], sessionModel: KEY, sessionLive: false }, CTX)).toEqual([
      { kind: "body-field", scenario: "body", request: "session-create POST /api/v1/freebuff/session", detail: 'key set: want [], got ["countryCode"]' },
    ]);
  });

  test("an extra metadata key reds; the cli: instance id always rides", () => {
    const withExtra = chatRow({}, { ...chatMetadata(), extra: 1 });
    const findings = compareScenario("extra-key", [withExtra], { ...FULL_PINS, expect: ["chat"] }, CTX);
    expect(findings).toEqual([
      {
        kind: "body-field",
        scenario: "extra-key",
        request: "chat POST /api/v1/chat/completions codebuff_metadata",
        detail:
          'key set: want ["client_id","cost_mode","freebuff_client_env","freebuff_input_profile","freebuff_instance_id","freebuff_multi_session","llm_step_number","repo_snapshot","run_id","surface","trace_session_id"], got ["client_id","cost_mode","extra","freebuff_client_env","freebuff_input_profile","freebuff_instance_id","freebuff_multi_session","llm_step_number","repo_snapshot","run_id","surface","trace_session_id"]',
      },
    ]);

    const dropped = chatRow();
    const droppedBody = JSON.parse(dropped.bodyRaw!) as Record<string, unknown>;
    const metadata = droppedBody["codebuff_metadata"] as Record<string, unknown>;
    delete metadata["freebuff_instance_id"];
    droppedBody["codebuff_metadata"] = metadata;
    const slice = [req("POST", "/api/v1/chat/completions", [...baseHeaders(CHAT_UA), ["Content-Type", "application/json"]], JSON.stringify(droppedBody))];
    const missing = compareScenario("no-instance", slice, { ...FULL_PINS, expect: ["chat"] }, CTX);
    expect(missing.some((finding) => finding.detail.includes("freebuff_instance_id"))).toBe(true);
  });

  test("volatile metadata shapes class: a short client_id, a non-uuid trace and a foreign instance id red", () => {
    const slice = conformingSlice();
    slice[2] = chatRow({}, { ...chatMetadata(), client_id: "short", trace_session_id: "not-a-uuid", freebuff_instance_id: "inst-other" });
    const findings = compareScenario("shapes", slice, FULL_PINS, CTX);
    expect(findings.map((finding) => finding.detail)).toEqual([
      'client_id: want 10 base-36 chars, got "short"',
      'trace_session_id: want a uuid, got "not-a-uuid"',
      'freebuff_instance_id: want a cli: uuid, got "inst-other"',
    ]);
  });

  test("a client stop passes through; no stop at all is the wire's default", () => {
    const pinned = conformingSlice();
    pinned[2] = chatRow({ stop: ["END"] });
    expect(compareScenario("stop", pinned, { ...FULL_PINS, chat: { model: HANDLE, stream: false, stop: ["END"] } }, CTX)).toEqual([]);

    const withDefault = conformingSlice();
    withDefault[2] = chatRow({ stop: ["cb_easp"] });
    const findings = compareScenario("cb-easp", withDefault, FULL_PINS, CTX);
    expect(findings).toEqual([
      { kind: "body-field", scenario: "cb-easp", request: "chat POST /api/v1/chat/completions", detail: 'stop: want absent, got ["cb_easp"]' },
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

  test("session polls are timing-owned: any count, a foreign instance id still reds", () => {
    const poll = (): RecordedRequest => req("GET", "/api/v1/freebuff/session", [...baseHeaders(CLI_UA), ["x-freebuff-instance-id", INSTANCE]]);
    const slice = [...conformingSlice(), poll(), poll()];
    expect(compareScenario("polls", slice, FULL_PINS, CTX)).toEqual([]);

    const wrong = [...conformingSlice(), req("GET", "/api/v1/freebuff/session", [...baseHeaders(CLI_UA), ["x-freebuff-instance-id", "inst-other"]])];
    const findings = compareScenario("wrong-instance", wrong, FULL_PINS, CTX);
    expect(findings).toEqual([
      { kind: "header", scenario: "wrong-instance", request: "session-poll GET /api/v1/freebuff/session", detail: 'x-freebuff-instance-id: want a cli: uuid when present, got "inst-other"' },
    ]);
  });

  test("the session end carries the cli: instance id", () => {
    const del = req("DELETE", "/api/v1/freebuff/session", [...baseHeaders(CLI_UA), ["x-freebuff-instance-id", INSTANCE]]);
    expect(compareScenario("end", [del], { expect: ["session-end"], sessionLive: false }, CTX)).toEqual([]);

    const wrong = req("DELETE", "/api/v1/freebuff/session", [...baseHeaders(CLI_UA), ["x-freebuff-instance-id", "inst-other"]]);
    const findings = compareScenario("end-wrong", [wrong], { expect: ["session-end"], sessionLive: false }, CTX);
    expect(findings).toEqual([
      { kind: "header", scenario: "end-wrong", request: "session-end DELETE /api/v1/freebuff/session", detail: 'x-freebuff-instance-id: want a cli: uuid, got "inst-other"' },
    ]);
  });
});
