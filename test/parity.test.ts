import { describe, expect, test } from "bun:test";
import { comparePollSpacing, compareScenario, requestClass, type CompareContext, type HeaderPair, type RecordedRequest, type ScenarioPins } from "../scripts/parity-core.ts";
import { upstreamHeaders } from "../src/transport.ts";

// The rows are hand-pinned from the 2026-10-27 live-drift capture: the
// per-class header sequences (the recording relay serializes them sorted, so
// every fixture below lists them in that order), the chat messages container,
// the metadata descriptors and the volatile shapes — never produced by the
// code under test, or a shared bug would stay green forever.

const TOKEN = "fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7";
const INSTANCE = "cli:11111111-2222-4333-8444-555555555555";
const ATTEMPT_ID = "11111111-2222-4333-8444-555555555555";
const HANDLE = "fbm1.stub.aaaa";
const AGENT = "base3-free-catalog";
const RUN_ID = "01a17cd4-59f0-7b55-963a-f6a1eb9a2c12";
const CHAT_UA = "ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser";
const CLI_UA = "Freebuff-CLI/0.2.34";
const API_UA = "Bun/1.3.14";

// The capture's own descriptors, verbatim.
const CLI_CLIENT_ENV =
  "v1;in=1;out=1;tp=tmux;term=1;ct=1;sz=220x50;ci=0;ssh=0;l=0;p=shell;g=mux;osc=1;tzo=0;px=none;tls=1;ca=0;cde=none";
const CLI_INPUT_PROFILE = "v1;tc=0;ke=0;mc=0;pc=0;pe=0;cps=0";
const CLI_REPO_SNAPSHOT =
  '{"gitAvailable":true,"repositoryVisibility":"unknown","fileCount":1,"fileCountIsLowerBound":false,"testFileCount":0,"historyIsShallow":false,"changedFileCount":0,"changedFileScanTruncated":false}';

// The CLI's 198-char system opening with a fixture-fixed date: the fixture
// fixes every interpolated value.
const SYSTEM_MESSAGE = {
  role: "system",
  content:
    "You are Buffy, the coding agent behind Codebuff. You help users with software engineering tasks: fixing bugs, adding functionality, refactoring, and explaining code.\n\nCurrent date: October 27, 2026.",
};
const MESSAGES: Array<Record<string, unknown>> = [SYSTEM_MESSAGE, { role: "user", content: "hi" }];

const CTX: CompareContext = { token: TOKEN, host: "127.0.0.1:9" };

function req(method: string, path: string, headers: Array<[string, string]>, bodyRaw: string | null = null, search = ""): RecordedRequest {
  return { method, path, search, headers, bodyRaw, at: 0 };
}

/** The capture's sorted base set: accept, accept-encoding, [authorization,]
 * connection, host, user-agent. */
function baseHeaders(userAgent: string, withAuthorization = true): HeaderPair[] {
  return [
    ["accept", "*/*"],
    ["accept-encoding", "gzip, deflate"],
    ...(withAuthorization ? ([["authorization", `Bearer ${TOKEN}`]] as HeaderPair[]) : []),
    ["connection", "keep-alive"],
    ["host", "127.0.0.1:9"],
    ["user-agent", userAgent],
  ];
}

/** The runtime headers on a body-carrying POST, in their sorted position. */
function postHeaders(bodyRaw: string): HeaderPair[] {
  return [
    ["content-length", String(bodyRaw.length)],
    ["content-type", "application/json"],
  ];
}

function apiPostHeaders(bodyRaw: string): HeaderPair[] {
  return [...baseHeaders(API_UA).slice(0, 4), ...postHeaders(bodyRaw), ...baseHeaders(API_UA).slice(4)];
}

function chatHeaders(userAgent: string, bodyRaw: string): HeaderPair[] {
  return [
    ["accept", "*/*"],
    ["accept-encoding", "gzip, deflate"],
    ["authorization", `Bearer ${TOKEN}`],
    ["connection", "keep-alive"],
    ["content-length", String(bodyRaw.length)],
    ["content-type", "application/json"],
    ["host", "127.0.0.1:9"],
    ["user-agent", userAgent],
    ["x-freebuff-sse-gzip-recovery", "1"],
  ];
}

function chatMetadata(): Record<string, unknown> {
  return {
    run_id: RUN_ID,
    client_id: "abc123def9",
    trace_session_id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    cost_mode: "free",
    freebuff_instance_id: INSTANCE,
    freebuff_multi_session: "1",
    surface: "cli",
    freebuff_client_env: CLI_CLIENT_ENV,
    freebuff_input_profile: CLI_INPUT_PROFILE,
    repo_snapshot: CLI_REPO_SNAPSHOT,
    llm_step_number: "1",
  };
}

function chatRow(body: Record<string, unknown> = {}, metadata = chatMetadata()): RecordedRequest {
  const bodyRaw = JSON.stringify({
    model: HANDLE,
    messages: MESSAGES,
    stream: false,
    codebuff_metadata: metadata,
    provider: { data_collection: "deny" },
    ...body,
  });
  return req("POST", "/api/v1/chat/completions", chatHeaders(CHAT_UA, bodyRaw), bodyRaw);
}

function runStartReq(): RecordedRequest {
  const bodyRaw = JSON.stringify({ action: "START", agentId: AGENT, ancestorRunIds: [] });
  return req("POST", "/api/v1/agent-runs", apiPostHeaders(bodyRaw), bodyRaw);
}

function runFinishReq(): RecordedRequest {
  const bodyRaw = JSON.stringify({ action: "FINISH", runId: RUN_ID, status: "completed", totalSteps: 0, directCredits: 0, totalCredits: 0 });
  return req("POST", "/api/v1/agent-runs", apiPostHeaders(bodyRaw), bodyRaw);
}

function admissionReq(): RecordedRequest {
  return req("POST", "/api/v1/freebuff/session/admission", [
    ...baseHeaders(CLI_UA),
    ["x-freebuff-client", "cli"],
    ["x-freebuff-client-version", "0.2.34"],
    ["x-freebuff-multi-session", "1"],
    ["x-freebuff-purchase-continuity", "1"],
    ["x-freebuff-desktop-attempt-id", ATTEMPT_ID],
    ["x-freebuff-instance-id", INSTANCE],
    ["x-freebuff-model", HANDLE],
    ["x-freebuff-wallet-spend-limit", "session"],
    ["x-freebuff-catalog-protocol", "1"],
  ]);
}

const FULL_PINS: ScenarioPins = {
  expect: ["models", "run-start", "chat", "run-finish"],
  forbid: ["session-create", "session-end", "admission"],
  agentId: AGENT,
  pollCount: 0,
  chat: { model: HANDLE, stream: false, messages: MESSAGES },
};

function conformingSlice(): RecordedRequest[] {
  return [
    req("GET", "/api/v1/freebuff/models", [...baseHeaders(CLI_UA), ["x-freebuff-catalog-protocol", "1"]]),
    runStartReq(),
    chatRow(),
    runFinishReq(),
  ];
}

describe("requestClass", () => {
  test("the models GET, the agent-runs pair, the chat and the admission classify; unknown paths class null", () => {
    expect(requestClass(conformingSlice()[0]!)).toBe("models");
    expect(requestClass(conformingSlice()[1]!)).toBe("run-start");
    expect(requestClass(conformingSlice()[2]!)).toBe("chat");
    expect(requestClass(conformingSlice()[3]!)).toBe("run-finish");
    expect(requestClass(req("POST", "/api/v1/freebuff/session/admission", [], ""))).toBe("admission");
    expect(requestClass(req("POST", "/api/v1/freebuff/session", [], "{}"))).toBe("session-create");
    expect(requestClass(req("GET", "/api/v1/freebuff/session", []))).toBe("session-poll");
    expect(requestClass(req("POST", "/api/v1/ads", [], "{}"))).toBeNull();
    expect(requestClass(req("POST", "/api/v1/agent-runs", [], JSON.stringify({ action: "OTHER" })))).toBeNull();
  });
});

const LOGIN_HASH = "d".repeat(64);
const LOGIN_QUERY = `?fingerprintId=clauth-freebuff-proxy-abc&fingerprintHash=${LOGIN_HASH}&expiresAt=1793094251375`;

describe("the proxy's header list construction", () => {
  // The runtime sorts these on the wire today (measured 2026-10-28 with a raw listener); this pins the built list's order, so a runtime that preserves it keeps the capture's intent.
  test("each class's list pins its order: the base set, then the bearer, then the extras", () => {
    expect(upstreamHeaders("api", TOKEN).map(([name]) => name)).toEqual(["Accept", "Accept-Encoding", "Connection", "Host", "User-Agent", "Authorization"]);
    expect(upstreamHeaders("api", null).map(([name]) => name)).toEqual(["Accept", "Accept-Encoding", "Connection", "Host", "User-Agent"]);
    expect(
      upstreamHeaders("chat", TOKEN, [
        ["Content-Type", "application/json"],
        ["x-freebuff-sse-gzip-recovery", "1"],
      ]).map(([name]) => name),
    ).toEqual(["Accept", "Accept-Encoding", "Connection", "Host", "User-Agent", "Authorization", "Content-Type", "x-freebuff-sse-gzip-recovery"]);
    expect(upstreamHeaders("cli", TOKEN, [["x-freebuff-catalog-protocol", "1"]]).map(([name]) => name)).toEqual([
      "Accept",
      "Accept-Encoding",
      "Connection",
      "Host",
      "User-Agent",
      "Authorization",
      "x-freebuff-catalog-protocol",
    ]);
  });
});

function unauthenticated(userAgent: string): HeaderPair[] {
  return baseHeaders(userAgent, false);
}

function loginSlice(query = LOGIN_QUERY): RecordedRequest[] {
  const bodyRaw = JSON.stringify({ fingerprintId: "clauth-freebuff-proxy-abc" });
  return [
    req(
      "POST",
      "/api/auth/cli/code",
      [...unauthenticated(API_UA).slice(0, 3), ...postHeaders(bodyRaw), ...unauthenticated(API_UA).slice(3)],
      bodyRaw,
    ),
    req("GET", "/api/auth/cli/status", unauthenticated(API_UA), null, query),
  ];
}

const LOGIN_PINS: ScenarioPins = { expect: ["login-code", "login-status"], pollCount: 0 };

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
    const chat = chatRow();
    slice[2] = { ...chat, headers: chatHeaders(API_UA, chat.bodyRaw ?? "") };
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
      headers: [...baseHeaders(CLI_UA).map(([name, value]): HeaderPair => (name === "authorization" ? ["authorization", "Bearer other-token"] : [name, value])), ["x-freebuff-catalog-protocol", "1"]],
    };
    const findings = compareScenario("bearer", slice, FULL_PINS, CTX);
    expect(findings).toEqual([
      { kind: "header", scenario: "bearer", request: "models GET /api/v1/freebuff/models", detail: 'Authorization: want "Bearer fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7", got "Bearer other-token"' },
    ]);
  });

  test("a header out of the capture's order is one header-order finding", () => {
    const slice = conformingSlice();
    const chat = chatRow();
    const headers = chatHeaders(CHAT_UA, chat.bodyRaw ?? "");
    const hostIndex = headers.findIndex(([name]) => name === "host");
    const uaIndex = headers.findIndex(([name]) => name === "user-agent");
    headers[hostIndex] = ["user-agent", CHAT_UA];
    headers[uaIndex] = ["host", "127.0.0.1:9"];
    slice[2] = { ...chat, headers };
    const findings = compareScenario("order", slice, FULL_PINS, CTX);
    expect(findings).toEqual([
      {
        kind: "header",
        scenario: "order",
        request: "chat POST /api/v1/chat/completions",
        detail:
          'header order: want the capture\'s [accept, accept-encoding, authorization, connection, content-length, content-type, host, user-agent, x-freebuff-acting-user-id, x-freebuff-catalog-fetch, x-freebuff-device-key, x-freebuff-device-sig, x-freebuff-device-ts, x-freebuff-sse-gzip-recovery], got "[accept, accept-encoding, authorization, connection, content-length, content-type, user-agent, host, x-freebuff-sse-gzip-recovery]"',
      },
    ]);
  });

  test("a header outside the class's capture set reds", () => {
    const slice = conformingSlice();
    const start = runStartReq();
    slice[1] = { ...start, headers: [...apiPostHeaders(start.bodyRaw ?? ""), ["x-freebuff-device-key", "4P2gXgfD0IorxebYOG7cqZ"]] };
    const findings = compareScenario("unpinned", slice, FULL_PINS, CTX);
    expect(findings).toEqual([
      { kind: "header", scenario: "unpinned", request: "run-start POST /api/v1/agent-runs", detail: 'header "x-freebuff-device-key": want the capture\'s run-start set, got "x-freebuff-device-key"' },
    ]);
  });

  test("a body-carrying POST without content-length reds; a GET carrying one reds", () => {
    const slice = conformingSlice();
    const chat = chatRow();
    slice[2] = { ...chat, headers: chatHeaders(CHAT_UA, chat.bodyRaw ?? "").filter(([name]) => name !== "content-length") };
    const findings = compareScenario("no-length", slice, FULL_PINS, CTX);
    expect(findings).toEqual([
      {
        kind: "header",
        scenario: "no-length",
        request: "chat POST /api/v1/chat/completions",
        detail:
          'header order: want the capture\'s [accept, accept-encoding, authorization, connection, content-length, content-type, host, user-agent, x-freebuff-acting-user-id, x-freebuff-catalog-fetch, x-freebuff-device-key, x-freebuff-device-sig, x-freebuff-device-ts, x-freebuff-sse-gzip-recovery], got "[accept, accept-encoding, authorization, connection, content-type, host, user-agent, x-freebuff-sse-gzip-recovery]"',
      },
      { kind: "header", scenario: "no-length", request: "chat POST /api/v1/chat/completions", detail: "content-length: want a decimal byte count, got null" },
    ]);

    const modelsWithLength = req("GET", "/api/v1/freebuff/models", [...baseHeaders(CLI_UA), ["content-length", "0"], ["x-freebuff-catalog-protocol", "1"]]);
    const getFindings = compareScenario("get-length", [modelsWithLength], { expect: ["models"], pollCount: 0 }, CTX);
    expect(getFindings).toEqual([
      { kind: "header", scenario: "get-length", request: "models GET /api/v1/freebuff/models", detail: 'header "content-length": want the capture\'s models set, got "content-length"' },
      { kind: "header", scenario: "get-length", request: "models GET /api/v1/freebuff/models", detail: 'content-length: want absent, got "0"' },
    ]);
  });

  test("a chat whose content-type is not application/json reds", () => {
    const slice = conformingSlice();
    const chat = chatRow();
    slice[2] = {
      ...chat,
      headers: chatHeaders(CHAT_UA, chat.bodyRaw ?? "").map(([name, value]): HeaderPair => (name === "content-type" ? ["content-type", "text/plain"] : [name, value])),
    };
    const findings = compareScenario("content-type", slice, FULL_PINS, CTX);
    expect(findings).toEqual([
      { kind: "header", scenario: "content-type", request: "chat POST /api/v1/chat/completions", detail: 'content-type: want "application/json", got "text/plain"' },
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
    const slice = [req("POST", "/api/v1/chat/completions", chatHeaders(CHAT_UA, JSON.stringify(droppedBody)), JSON.stringify(droppedBody))];
    const missing = compareScenario("no-instance", slice, { ...FULL_PINS, expect: ["chat"] }, CTX);
    expect(missing).toEqual([
      {
        kind: "body-field",
        scenario: "no-instance",
        request: "chat POST /api/v1/chat/completions codebuff_metadata",
        detail:
          'key set: want ["client_id","cost_mode","freebuff_client_env","freebuff_input_profile","freebuff_instance_id","freebuff_multi_session","llm_step_number","repo_snapshot","run_id","surface","trace_session_id"], got ["client_id","cost_mode","freebuff_client_env","freebuff_input_profile","freebuff_multi_session","llm_step_number","repo_snapshot","run_id","surface","trace_session_id"]',
      },
      {
        kind: "body-field",
        scenario: "no-instance",
        request: "chat POST /api/v1/chat/completions codebuff_metadata",
        detail: "freebuff_instance_id: want a cli: uuid, got null",
      },
    ]);
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

  test("a metadata descriptor or run id that drifted from the capture's reds", () => {
    const withEnv = compareScenario("env", [chatRow({}, { ...chatMetadata(), freebuff_client_env: "v1;in=1" })], { ...FULL_PINS, expect: ["chat"] }, CTX);
    expect(withEnv).toEqual([
      {
        kind: "body-field",
        scenario: "env",
        request: "chat POST /api/v1/chat/completions codebuff_metadata",
        detail: `freebuff_client_env: want the capture's descriptor ${JSON.stringify(CLI_CLIENT_ENV)}, got "v1;in=1"`,
      },
    ]);

    const withSnapshot = compareScenario("snapshot", [chatRow({}, { ...chatMetadata(), repo_snapshot: "{}" })], { ...FULL_PINS, expect: ["chat"] }, CTX);
    expect(withSnapshot).toEqual([
      {
        kind: "body-field",
        scenario: "snapshot",
        request: "chat POST /api/v1/chat/completions codebuff_metadata",
        detail: `repo_snapshot: want the capture's snapshot ${JSON.stringify(CLI_REPO_SNAPSHOT)}, got "{}"`,
      },
    ]);

    const withRunId = compareScenario("run-id", [chatRow({}, { ...chatMetadata(), run_id: "run-1" })], { ...FULL_PINS, expect: ["chat"] }, CTX);
    expect(withRunId).toEqual([
      { kind: "body-field", scenario: "run-id", request: "chat POST /api/v1/chat/completions codebuff_metadata", detail: 'run_id: want a uuid, got "run-1"' },
    ]);
  });

  test("the messages container compares by exact equality", () => {
    const wrongText = compareScenario("text", [chatRow({ messages: [{ role: "user", content: "bye" }] })], { ...FULL_PINS, expect: ["chat"] }, CTX);
    expect(wrongText).toEqual([
      {
        kind: "body-field",
        scenario: "text",
        request: "chat POST /api/v1/chat/completions",
        detail: `messages: want ${JSON.stringify(MESSAGES)}, got ${JSON.stringify([{ role: "user", content: "bye" }])}`,
      },
    ]);

    const wrongKeyOrder = compareScenario("key-order", [chatRow({ messages: [{ content: "hi", role: "user" }] })], { ...FULL_PINS, expect: ["chat"] }, CTX);
    expect(wrongKeyOrder).toEqual([
      {
        kind: "body-field",
        scenario: "key-order",
        request: "chat POST /api/v1/chat/completions",
        detail: `messages: want ${JSON.stringify(MESSAGES)}, got ${JSON.stringify([{ content: "hi", role: "user" }])}`,
      },
    ]);

    const extra = compareScenario("extra-message", [chatRow({ messages: [...MESSAGES, { role: "user", content: "more" }] })], { ...FULL_PINS, expect: ["chat"] }, CTX);
    expect(extra).toEqual([
      {
        kind: "body-field",
        scenario: "extra-message",
        request: "chat POST /api/v1/chat/completions",
        detail: `messages: want ${JSON.stringify(MESSAGES)}, got ${JSON.stringify([...MESSAGES, { role: "user", content: "more" }])}`,
      },
    ]);
  });

  test("a client stop passes through; no stop at all is the wire's default", () => {
    const pinned = conformingSlice();
    pinned[2] = chatRow({ stop: ["END"] });
    expect(compareScenario("stop", pinned, { ...FULL_PINS, chat: { ...FULL_PINS.chat!, stop: ["END"] } }, CTX)).toEqual([]);

    const withDefault = conformingSlice();
    withDefault[2] = chatRow({ stop: ["cb_easp"] });
    const findings = compareScenario("cb-easp", withDefault, FULL_PINS, CTX);
    expect(findings).toEqual([
      { kind: "body-field", scenario: "cb-easp", request: "chat POST /api/v1/chat/completions", detail: 'stop: want absent, got ["cb_easp"]' },
    ]);
  });

  test("a nonzero credit or a non-uuid run id on the FINISH reds", () => {
    const finBody = JSON.stringify({ action: "FINISH", runId: RUN_ID, status: "completed", totalSteps: 0, directCredits: 0, totalCredits: 5 });
    const slice = conformingSlice();
    slice[3] = req("POST", "/api/v1/agent-runs", apiPostHeaders(finBody), finBody);
    const findings = compareScenario("credits", slice, FULL_PINS, CTX);
    expect(findings).toEqual([
      { kind: "body-field", scenario: "credits", request: "run-finish POST /api/v1/agent-runs", detail: "totalCredits: want 0, got 5" },
    ]);

    const badRunIdBody = JSON.stringify({ action: "FINISH", runId: "run-1", status: "completed", totalSteps: 0, directCredits: 0, totalCredits: 0 });
    const badRunId = conformingSlice();
    badRunId[3] = req("POST", "/api/v1/agent-runs", apiPostHeaders(badRunIdBody), badRunIdBody);
    const runIdFindings = compareScenario("run-id", badRunId, FULL_PINS, CTX);
    expect(runIdFindings).toEqual([
      { kind: "body-field", scenario: "run-id", request: "run-finish POST /api/v1/agent-runs", detail: 'runId: want a uuid, got "run-1"' },
      {
        kind: "body-field",
        scenario: "run-id",
        request: "the run-id chain",
        detail: `the chat's run_id ${JSON.stringify(RUN_ID)} does not match the FINISH runId "run-1"`,
      },
    ]);
  });

  test("the session-poll count compares exactly; a foreign instance id still reds", () => {
    const poll = (): RecordedRequest => req("GET", "/api/v1/freebuff/session", [...baseHeaders(CLI_UA), ["x-freebuff-instance-id", INSTANCE]]);
    const onePoll = compareScenario("poll", [...conformingSlice(), poll()], FULL_PINS, CTX);
    expect(onePoll).toEqual([
      { kind: "missing-request", scenario: "poll", request: "session-poll", detail: "expected exactly 0, saw 1" },
    ]);

    const twoPolls = compareScenario("polls", [...conformingSlice(), poll(), poll()], { ...FULL_PINS, pollCount: 2 }, CTX);
    expect(twoPolls).toEqual([]);

    const wrong = compareScenario(
      "wrong-instance",
      [...conformingSlice(), poll(), req("GET", "/api/v1/freebuff/session", [...baseHeaders(CLI_UA), ["x-freebuff-instance-id", "inst-other"]])],
      { ...FULL_PINS, pollCount: 2 },
      CTX,
    );
    expect(wrong).toEqual([
      { kind: "header", scenario: "wrong-instance", request: "session-poll GET /api/v1/freebuff/session", detail: 'x-freebuff-instance-id: want a cli: uuid, got "inst-other"' },
    ]);

    const noId = compareScenario(
      "no-instance-id",
      [...conformingSlice(), req("GET", "/api/v1/freebuff/session", baseHeaders(CLI_UA))],
      { ...FULL_PINS, pollCount: 1 },
      CTX,
    );
    expect(noId).toEqual([
      { kind: "header", scenario: "no-instance-id", request: "session-poll GET /api/v1/freebuff/session", detail: "x-freebuff-instance-id: want a cli: uuid, got null" },
    ]);
  });

  test("the session end carries the cli: instance id", () => {
    const del = req("DELETE", "/api/v1/freebuff/session", [...baseHeaders(CLI_UA), ["x-freebuff-instance-id", INSTANCE]]);
    expect(compareScenario("end", [del], { expect: ["session-end"], pollCount: 0 }, CTX)).toEqual([]);

    const wrong = req("DELETE", "/api/v1/freebuff/session", [...baseHeaders(CLI_UA), ["x-freebuff-instance-id", "inst-other"]]);
    const findings = compareScenario("end-wrong", [wrong], { expect: ["session-end"], pollCount: 0 }, CTX);
    expect(findings).toEqual([
      { kind: "header", scenario: "end-wrong", request: "session-end DELETE /api/v1/freebuff/session", detail: 'x-freebuff-instance-id: want a cli: uuid, got "inst-other"' },
    ]);
  });

  test("a session create is forbidden on the happy path", () => {
    const create = req("POST", "/api/v1/freebuff/session", baseHeaders(CLI_UA), JSON.stringify({}));
    const findings = compareScenario("create", [...conformingSlice(), create], FULL_PINS, CTX);
    expect(findings).toEqual([
      { kind: "unexpected-request", scenario: "create", request: "POST /api/v1/freebuff/session", detail: "session-create is forbidden in this scenario" },
    ]);
  });

  test("the waiting-room admission pins its headers and dials no body", () => {
    const admission = admissionReq();
    expect(compareScenario("admission", [admission], { expect: ["admission"], pollCount: 0 }, CTX)).toEqual([]);

    const wrongClient = admissionReq();
    const clientHeaders = wrongClient.headers.map(([name, value]): HeaderPair => (name === "x-freebuff-client" ? ["x-freebuff-client", "web"] : [name, value]));
    const clientFindings = compareScenario("wrong-client", [{ ...wrongClient, headers: clientHeaders }], { expect: ["admission"], pollCount: 0 }, CTX);
    expect(clientFindings).toEqual([
      { kind: "header", scenario: "wrong-client", request: "admission POST /api/v1/freebuff/session/admission", detail: 'x-freebuff-client: want "cli", got "web"' },
    ]);

    const withBody = admissionReq();
    const bodyHeaders = [...withBody.headers.slice(0, 4), ...([["content-length", "2"]] as HeaderPair[]), ...withBody.headers.slice(4)];
    const bodyFindings = compareScenario("admission-body", [{ ...withBody, headers: bodyHeaders, bodyRaw: "{}" }], { expect: ["admission"], pollCount: 0 }, CTX);
    expect(bodyFindings).toEqual([
      { kind: "body-field", scenario: "admission-body", request: "admission POST /api/v1/freebuff/session/admission", detail: "this request carries no body" },
    ]);

    const prefixedAttempt = req(
      "POST",
      "/api/v1/freebuff/session/admission",
      [
        ...baseHeaders(CLI_UA),
        ["x-freebuff-client", "cli"],
        ["x-freebuff-client-version", "0.2.34"],
        ["x-freebuff-multi-session", "1"],
        ["x-freebuff-purchase-continuity", "1"],
        ["x-freebuff-desktop-attempt-id", INSTANCE],
        ["x-freebuff-instance-id", INSTANCE],
        ["x-freebuff-model", HANDLE],
        ["x-freebuff-wallet-spend-limit", "session"],
        ["x-freebuff-catalog-protocol", "1"],
      ],
    );
    const attemptFindings = compareScenario("attempt", [prefixedAttempt], { expect: ["admission"], pollCount: 0 }, CTX);
    expect(attemptFindings).toEqual([
      {
        kind: "header",
        scenario: "attempt",
        request: "admission POST /api/v1/freebuff/session/admission",
        detail: `x-freebuff-desktop-attempt-id: want the instance uuid without the cli: prefix, got "${INSTANCE}"`,
      },
    ]);

    const forbidden = compareScenario("forbidden", [...conformingSlice(), admission], FULL_PINS, CTX);
    expect(forbidden).toEqual([
      { kind: "unexpected-request", scenario: "forbidden", request: "POST /api/v1/freebuff/session/admission", detail: "admission is forbidden in this scenario" },
    ]);
  });

  test("a run START on another agent reds", () => {
    const slice = conformingSlice();
    const bodyRaw = JSON.stringify({ action: "START", agentId: "base2-free", ancestorRunIds: [] });
    slice[1] = req("POST", "/api/v1/agent-runs", apiPostHeaders(bodyRaw), bodyRaw);
    const findings = compareScenario("agent", slice, FULL_PINS, CTX);
    expect(findings).toEqual([
      { kind: "body-field", scenario: "agent", request: "run-start POST /api/v1/agent-runs", detail: 'agentId: want "base3-free-catalog", got "base2-free"' },
    ]);
  });

  test("the run-id chain pins one id across the chat and its FINISH", () => {
    const mismatched = conformingSlice();
    const finBody = JSON.stringify({ action: "FINISH", runId: "01a17cd4-59f0-7b55-963a-f6a1eb9a2c13", status: "completed", totalSteps: 0, directCredits: 0, totalCredits: 0 });
    mismatched[3] = req("POST", "/api/v1/agent-runs", apiPostHeaders(finBody), finBody);
    const findings = compareScenario("chain", mismatched, FULL_PINS, CTX);
    expect(findings).toEqual([
      {
        kind: "body-field",
        scenario: "chain",
        request: "the run-id chain",
        detail: `the chat's run_id ${JSON.stringify(RUN_ID)} does not match the FINISH runId "01a17cd4-59f0-7b55-963a-f6a1eb9a2c13"`,
      },
    ]);
  });

  test("content-length must match the body's byte count", () => {
    const slice = conformingSlice();
    const chat = chatRow();
    const bytes = new TextEncoder().encode(chat.bodyRaw ?? "").length;
    slice[2] = {
      ...chat,
      headers: chatHeaders(CHAT_UA, chat.bodyRaw ?? "").map(([name, value]): HeaderPair => (name === "content-length" ? ["content-length", "9999"] : [name, value])),
    };
    const findings = compareScenario("bytes", slice, FULL_PINS, CTX);
    expect(findings).toEqual([
      { kind: "header", scenario: "bytes", request: "chat POST /api/v1/chat/completions", detail: `content-length: want the body's ${bytes} bytes, got "9999"` },
    ]);
  });
});

describe("comparePollSpacing", () => {
  const pollAt = (at: number): RecordedRequest => ({ ...req("GET", "/api/v1/freebuff/session", []), at });

  test("consecutive gaps around one second pass; a fast or slow gap reds", () => {
    expect(comparePollSpacing("cadence", [0, 1000, 2000, 3001].map(pollAt))).toEqual([]);

    expect(comparePollSpacing("fast", [0, 1000, 1500].map(pollAt))).toEqual([
      { kind: "cadence", scenario: "fast", request: "session-poll spacing", detail: "gap 500 ms between consecutive polls: want within [900, 1100]" },
    ]);

    expect(comparePollSpacing("slow", [0, 1000, 2600].map(pollAt))).toEqual([
      { kind: "cadence", scenario: "slow", request: "session-poll spacing", detail: "gap 1600 ms between consecutive polls: want within [900, 1100]" },
    ]);
  });

  test("fewer than two polls compare no gap", () => {
    expect(comparePollSpacing("one", [pollAt(0)])).toEqual([]);
    expect(comparePollSpacing("none", [])).toEqual([]);
  });
});
