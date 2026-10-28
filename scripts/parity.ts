/**
 * The wire-parity run: the real proxy process, driven against the stub
 * upstream (scripts/stub-freebuff.ts), has every upstream request compared
 * against the shapes the 2026-10-27 live-drift capture pins through
 * scripts/parity-core.ts. The capture is the parity reference, not a live
 * client — the CLI ships its protocol in a compiled binary. A finding fails
 * the run (exit 1): a shape difference is a diff to fix, never a waived
 * check.
 */

import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_PATH } from "../src/transport.ts";
import {
  comparePollSpacing,
  compareScenario,
  type CompareContext,
  type ParityFinding,
  type RequestClass,
  type ScenarioPins,
} from "./parity-core.ts";
import {
  HarnessRuntime,
  freePort,
  makeRunDirs,
  pasteLogin,
  startProxy,
  startStub,
  waitFor,
  writeSecretFile,
  type StubHandle,
} from "./harness.ts";

const SCRATCH_ROOT = process.env.PARITY_SCRATCH_DIR || join(tmpdir(), "clauth-freebuff-proxy-parity");
const FREEBUFF_TOKEN = "fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7";
const TOOL_NAME = "get_weather";
const USER_TEXT = [{ role: "user", content: "hi" }];

// The stub catalogue's open, non-premium row: its key is what a client
// addresses, its signed handle is what the chat body's model field must
// carry, and its display-name slug addresses the same row.
const MODEL_KEY = "m-61c26317cc";
const MODEL_HANDLE = "fbm1.stub.aaaa";
const MODEL_SLUG = "mimo-v2-6-flash-slow";
/** The run agent the CLI 0.2.34 free-catalog chats START. */
const RUN_AGENT = "base3-free-catalog";

const WEATHER_TOOL = { name: TOOL_NAME, description: "get weather", input_schema: { type: "object", properties: { city: { type: "string" } } } };
const OPENAI_WEATHER = { type: "function", function: { name: TOOL_NAME, description: "get weather", parameters: { type: "object", properties: { city: { type: "string" } } } } };

// The happy path's request set: the catalogue fetch and the run chain ride;
// the session wire, the login routes, the streak probe and the waiting-room
// admission never do (the capture's chat exchanges dial none of them). The
// one session-poll per scenario slice is the usage cadence's own figure
// read, aligned below, never a scenario dial.
const CHAT_FORBIDDEN: RequestClass[] = ["session-create", "session-end", "admission", "streak", "login-code", "login-status"];
const DIAL_NOTHING_FORBIDDEN: RequestClass[] = [...CHAT_FORBIDDEN, "run-start", "run-finish", "chat"];
const LOGIN_SLICE_FORBIDDEN: RequestClass[] = ["session-create", "session-end", "admission", "run-start", "run-finish", "chat"];

/** The CLI's 198-char system opening through the live UTC date, pinned here
 * and never read from the proxy: a drifted prefix must red this run, not
 * ride along with the code that injected it. */
function expectedMessages(now: Date): Array<Record<string, unknown>> {
  const date = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }).format(now);
  const system =
    "You are Buffy, the coding agent behind Codebuff. You help users with software engineering tasks: fixing bugs, adding functionality, refactoring, and explaining code.\n\nCurrent date: " +
    `${date}.`;
  return [
    { role: "system", content: system },
    { role: "user", content: "hi" },
  ];
}

interface Answer {
  status: number;
  body: unknown;
}

async function postJson(url: string, key: string, body: unknown): Promise<Answer> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

function pollCountOf(reqs: Array<{ method: string; path: string }>): number {
  return reqs.filter((req) => req.method === "GET" && req.path === SESSION_PATH).length;
}

/** Wait for the usage cadence's next session poll. The core polls the session
 * figure once a second from account readiness; each scenario slice is
 * bracketed around exactly one of those ticks, so the poll-count pin is exact
 * by construction — a poll beyond the cadence's rate reds it. */
async function alignToCadence(stub: StubHandle, seenPolls: number): Promise<void> {
  await waitFor(async () => pollCountOf(await stub.requests()) > seenPolls, "the usage cadence's next session poll", 5_000);
}

interface Scenario {
  name: string;
  pins: ScenarioPins;
  wantStatus: number;
  send?: (proxyBase: string, inferenceKey: string) => Promise<Answer>;
}

function chatScenario(name: string, request: Record<string, unknown>, pins: ScenarioPins): Scenario {
  return {
    name,
    pins,
    wantStatus: 200,
    send: (proxyBase, inferenceKey) => postJson(`${proxyBase}/v1/messages`, inferenceKey, { max_tokens: 16, messages: USER_TEXT, ...request }),
  };
}

function scenarios(messages: Array<Record<string, unknown>>): Scenario[] {
  const chat = (extra: Partial<NonNullable<ScenarioPins["chat"]>> = {}): NonNullable<ScenarioPins["chat"]> => ({
    model: MODEL_HANDLE,
    stream: false,
    messages,
    ...extra,
  });
  return [
    chatScenario("text chat (non-streaming, no tools)", { model: MODEL_KEY, max_tokens: 256 }, {
      expect: ["run-start", "chat", "run-finish"],
      forbid: CHAT_FORBIDDEN,
      agentId: RUN_AGENT,
      pollCount: 1,
      chat: chat({ fields: { max_tokens: 256 } }),
    }),
    chatScenario("tool_choice any becomes required", { model: MODEL_KEY, tools: [WEATHER_TOOL], tool_choice: { type: "any" } }, {
      expect: ["run-start", "chat", "run-finish"],
      forbid: CHAT_FORBIDDEN,
      agentId: RUN_AGENT,
      pollCount: 1,
      chat: chat({ fields: { tools: [OPENAI_WEATHER], tool_choice: "required" } }),
    }),
    chatScenario("tool_choice naming a tool becomes the function form", { model: MODEL_KEY, tools: [WEATHER_TOOL], tool_choice: { type: "tool", name: TOOL_NAME } }, {
      expect: ["run-start", "chat", "run-finish"],
      forbid: CHAT_FORBIDDEN,
      agentId: RUN_AGENT,
      pollCount: 1,
      chat: chat({ fields: { tool_choice: { type: "function", function: { name: TOOL_NAME } } } }),
    }),
    chatScenario("tool_choice auto with parallel calls off inverts the flag", { model: MODEL_KEY, tools: [WEATHER_TOOL], tool_choice: { type: "auto", disable_parallel_tool_use: true } }, {
      expect: ["run-start", "chat", "run-finish"],
      forbid: CHAT_FORBIDDEN,
      agentId: RUN_AGENT,
      pollCount: 1,
      chat: chat({ fields: { tool_choice: "auto", parallel_tool_calls: false } }),
    }),
    chatScenario("tools without tool_choice leave it absent", { model: MODEL_KEY, tools: [WEATHER_TOOL] }, {
      expect: ["run-start", "chat", "run-finish"],
      forbid: CHAT_FORBIDDEN,
      agentId: RUN_AGENT,
      pollCount: 1,
      chat: chat({ absentKeys: ["tool_choice"], fields: { tools: [OPENAI_WEATHER] } }),
    }),
    chatScenario("a streaming chat rides stream true", { model: MODEL_KEY, stream: true }, {
      expect: ["run-start", "chat", "run-finish"],
      forbid: CHAT_FORBIDDEN,
      agentId: RUN_AGENT,
      pollCount: 1,
      chat: chat({ stream: true }),
    }),
    chatScenario("the display-name slug dials the same row", { model: MODEL_SLUG }, {
      expect: ["run-start", "chat", "run-finish"],
      forbid: CHAT_FORBIDDEN,
      agentId: RUN_AGENT,
      pollCount: 1,
      chat: chat(),
    }),
    chatScenario("the contract's haiku id dials the default open row", { model: "claude-haiku-4-5" }, {
      expect: ["run-start", "chat", "run-finish"],
      forbid: CHAT_FORBIDDEN,
      agentId: RUN_AGENT,
      pollCount: 1,
      chat: chat(),
    }),
    chatScenario("stop_sequences pass through instead of the default", { model: MODEL_KEY, stop_sequences: ["END"] }, {
      expect: ["run-start", "chat", "run-finish"],
      forbid: CHAT_FORBIDDEN,
      agentId: RUN_AGENT,
      pollCount: 1,
      chat: chat({ stop: ["END"] }),
    }),
    {
      name: "count_tokens dials nothing",
      pins: { expect: [], forbid: DIAL_NOTHING_FORBIDDEN, pollCount: 1 },
      wantStatus: 200,
      send: (proxyBase, inferenceKey) => postJson(`${proxyBase}/v1/messages/count_tokens`, inferenceKey, { model: MODEL_KEY, messages: USER_TEXT }),
    },
    {
      name: "an unknown model dials nothing",
      pins: { expect: [], forbid: DIAL_NOTHING_FORBIDDEN, pollCount: 1 },
      wantStatus: 400,
      send: (proxyBase, inferenceKey) => postJson(`${proxyBase}/v1/messages`, inferenceKey, { model: "gpt-4o", max_tokens: 16, messages: USER_TEXT }),
    },
  ];
}

async function main(): Promise<void> {
  const runtime = new HarnessRuntime(SCRATCH_ROOT);
  runtime.installSignalHandlers();
  try {
    const dirs = makeRunDirs(runtime, SCRATCH_ROOT);
    const adminToken = randomBytes(32).toString("hex");
    writeSecretFile(dirs.adminTokenFile, adminToken + "\n");

    const secrets: [string, string][] = [
      ["admin token", adminToken],
      ["freebuff token", FREEBUFF_TOKEN],
    ];
    const scrub = (text: string): string => {
      let out = text;
      for (const [what, value] of secrets) out = out.split(value).join(`<${what} withheld>`);
      return out;
    };

    const stub = await startStub(runtime, dirs.runDir);
    const proxy = await startProxy(runtime, dirs, { port: freePort(), upstreamBase: stub.base });
    const login = await pasteLogin(proxy.base, adminToken, FREEBUFF_TOKEN);
    secrets.push(["inference key", login.inferenceKey]);

    // The proxy-side request gap paces chats but never changes a wire shape;
    // the parity run zeroes it so each scenario slice ends well inside one
    // usage-cadence interval, keeping the aligned poll count exact.
    const gapPatch = await fetch(`${proxy.base}/clauth/v1/accounts/${login.accountId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ settings: { request_gap_ms: 0 } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!gapPatch.ok) throw new Error(`zeroing the request gap answered ${gapPatch.status}: ${await gapPatch.text()}`);

    const ctx: CompareContext = {
      token: FREEBUFF_TOKEN,
      host: new URL(stub.base).host,
    };

    const findings: ParityFinding[] = [];
    let requestsTotal = 0;
    const runScenarios = scenarios(expectedMessages(new Date()));

    // The login slice closes on the usage cadence's first poll after the
    // account became ready: the paste's own dials ride, then exactly that
    // one poll — the cadence never dials before a ready account exists, so
    // the count is exact by construction.
    await alignToCadence(stub, 0);
    const loginReqs = await stub.requests();
    requestsTotal += loginReqs.length;
    const loginFindings = compareScenario(
      "paste login starts a code and probes the streak",
      loginReqs,
      { expect: ["login-code", "streak"], forbid: LOGIN_SLICE_FORBIDDEN, pollCount: 1 },
      ctx,
    );
    findings.push(...loginFindings);
    console.log(`parity: paste login starts a code and probes the streak: ${loginFindings.length === 0 ? "ok" : `${loginFindings.length} finding(s)`} (${loginReqs.length} upstream request(s))`);

    for (const scenario of runScenarios) {
      const before = await stub.requests();
      await alignToCadence(stub, pollCountOf(before));
      const start = before.length;
      if (scenario.send !== undefined) {
        const answer = await scenario.send(proxy.base, login.inferenceKey);
        if (answer.status !== scenario.wantStatus) {
          findings.push({
            kind: "missing-request",
            scenario: scenario.name,
            request: "the client request",
            detail: `answered ${answer.status}, want ${scenario.wantStatus}: ${scrub(JSON.stringify(answer.body)).slice(0, 400)}`,
          });
        }
      }
      const slice = (await stub.requests()).slice(start);
      requestsTotal += slice.length;
      const found = compareScenario(scenario.name, slice, scenario.pins, ctx);
      findings.push(...found);
      console.log(`parity: ${scenario.name}: ${found.length === 0 ? "ok" : `${found.length} finding(s)`} (${slice.length} upstream request(s))`);
    }

    // The cadence's own rate, off the full log: consecutive poll gaps must
    // sit around one second, whatever the scenario slices bracket.
    const allReqs = await stub.requests();
    const cadencePolls = allReqs.filter((req) => req.method === "GET" && req.path === SESSION_PATH);
    const gaps = cadencePolls.slice(1).map((poll, i) => poll.at - cadencePolls[i]!.at);
    const cadenceFindings = comparePollSpacing("the usage cadence's poll spacing", cadencePolls);
    findings.push(...cadenceFindings);
    console.log(`parity: the usage cadence's poll spacing: ${cadenceFindings.length === 0 ? "ok" : `${cadenceFindings.length} finding(s)`} (gaps [${gaps.join(", ")}] ms across ${cadencePolls.length} polls)`);

    if (findings.length > 0) {
      console.error(`parity: FAIL: ${findings.length} finding(s):`);
      for (const finding of findings) {
        console.error(`  [${finding.kind}] ${finding.scenario} — ${finding.request}: ${finding.detail}`);
      }
      process.exit(1);
    }
    console.log(`parity: ${requestsTotal} upstream requests across ${runScenarios.length + 1} slices, 0 findings`);
    console.log("parity: PASS");
  } finally {
    await runtime.teardown();
  }
}

try {
  await main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`parity: FAIL: ${message}`);
  process.exit(1);
}
