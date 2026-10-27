/**
 * The wire-parity run: the real proxy process, driven against the stub
 * upstream (scripts/stub-freebuff.ts), has every upstream request compared
 * against the shapes the protocol brief pins through scripts/parity-core.ts.
 * The brief is the parity reference, not a live client — the CLI ships its
 * protocol in a compiled binary (brief §sources). A finding fails the run
 * (exit 1): a shape difference is a diff to fix, never a waived check.
 */

import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
  writeSecretFile,
} from "./harness.ts";

const SCRATCH_ROOT = process.env.PARITY_SCRATCH_DIR || join(tmpdir(), "clauth-freebuff-proxy-parity");
const FREEBUFF_TOKEN = "fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7";
const MODEL = "minimax/minimax-m2.7";
const MODEL_AGENT = "base2-free";
const TOOL_NAME = "get_weather";
const USER_TEXT = [{ role: "user", content: "hi" }];

const WEATHER_TOOL = { name: TOOL_NAME, description: "get weather", input_schema: { type: "object", properties: { city: { type: "string" } } } };
const OPENAI_WEATHER = { type: "function", function: { name: TOOL_NAME, description: "get weather", parameters: { type: "object", properties: { city: { type: "string" } } } } };

const FORBIDDEN_EXCEPT_POLL: RequestClass[] = ["session-create", "session-end", "run-start", "run-finish", "chat", "streak"];
const FORBIDDEN_EXCEPT_POLL_AND_STREAK: RequestClass[] = ["session-create", "session-end", "run-start", "run-finish", "chat"];

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

const SCENARIOS: Scenario[] = [
  chatScenario("text chat (non-streaming, no tools)", { model: MODEL, max_tokens: 256 }, {
    expect: ["session-create", "run-start", "chat", "run-finish"],
    forbid: ["streak"],
    agentId: MODEL_AGENT,
    sessionModel: MODEL,
    sessionLive: true,
    chat: { model: MODEL, stream: false, fields: { max_tokens: 256 } },
  }),
  chatScenario("tool_choice any becomes required", { model: MODEL, tools: [WEATHER_TOOL], tool_choice: { type: "any" } }, {
    expect: ["run-start", "chat", "run-finish"],
    sessionLive: true,
    chat: { model: MODEL, stream: false, fields: { tools: [OPENAI_WEATHER], tool_choice: "required" } },
  }),
  chatScenario("tool_choice naming a tool becomes the function form", { model: MODEL, tools: [WEATHER_TOOL], tool_choice: { type: "tool", name: TOOL_NAME } }, {
    expect: ["run-start", "chat", "run-finish"],
    sessionLive: true,
    chat: { model: MODEL, stream: false, fields: { tool_choice: { type: "function", function: { name: TOOL_NAME } } } },
  }),
  chatScenario("tool_choice auto with parallel calls off inverts the flag", { model: MODEL, tools: [WEATHER_TOOL], tool_choice: { type: "auto", disable_parallel_tool_use: true } }, {
    expect: ["run-start", "chat", "run-finish"],
    sessionLive: true,
    chat: { model: MODEL, stream: false, fields: { tool_choice: "auto", parallel_tool_calls: false } },
  }),
  chatScenario("tools without tool_choice leave it absent", { model: MODEL, tools: [WEATHER_TOOL] }, {
    expect: ["run-start", "chat", "run-finish"],
    sessionLive: true,
    chat: { model: MODEL, stream: false, absentKeys: ["tool_choice"], fields: { tools: [OPENAI_WEATHER] } },
  }),
  chatScenario("a streaming chat rides stream true", { model: MODEL, stream: true }, {
    expect: ["run-start", "chat", "run-finish"],
    sessionLive: true,
    chat: { model: MODEL, stream: true },
  }),
  chatScenario("the shortcut alias dials the canonical id", { model: "minimax-m2.7" }, {
    expect: ["run-start", "chat", "run-finish"],
    sessionLive: true,
    chat: { model: MODEL, stream: false },
  }),
  chatScenario("the contract's haiku id dials the canonical id", { model: "claude-haiku-4-5" }, {
    expect: ["run-start", "chat", "run-finish"],
    sessionLive: true,
    chat: { model: MODEL, stream: false },
  }),
  chatScenario("stop_sequences pass through instead of the default", { model: MODEL, stop_sequences: ["END"] }, {
    expect: ["run-start", "chat", "run-finish"],
    sessionLive: true,
    chat: { model: MODEL, stream: false, stop: ["END"] },
  }),
  {
    name: "count_tokens dials nothing",
    pins: { expect: [], forbid: FORBIDDEN_EXCEPT_POLL, sessionLive: true },
    wantStatus: 200,
    send: (proxyBase, inferenceKey) => postJson(`${proxyBase}/v1/messages/count_tokens`, inferenceKey, { model: MODEL, messages: USER_TEXT }),
  },
  {
    name: "an unknown model dials nothing",
    pins: { expect: [], forbid: FORBIDDEN_EXCEPT_POLL, sessionLive: true },
    wantStatus: 400,
    send: (proxyBase, inferenceKey) => postJson(`${proxyBase}/v1/messages`, inferenceKey, { model: "gpt-4o", max_tokens: 16, messages: USER_TEXT }),
  },
];

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

    const ctx: CompareContext = {
      token: FREEBUFF_TOKEN,
      host: new URL(stub.base).host,
      instanceId: "inst-1",
    };

    const findings: ParityFinding[] = [];
    let requestsTotal = 0;

    // The login slice: the streak probe the paste door validates through, and
    // nothing else on the freebuff wire.
    const loginReqs = await stub.requests();
    requestsTotal += loginReqs.length;
    const loginFindings = compareScenario(
      "paste login probes the streak",
      loginReqs,
      { expect: ["streak"], forbid: FORBIDDEN_EXCEPT_POLL_AND_STREAK, sessionLive: false },
      ctx,
    );
    findings.push(...loginFindings);
    console.log(`parity: paste login probes the streak: ${loginFindings.length === 0 ? "ok" : `${loginFindings.length} finding(s)`} (${loginReqs.length} upstream request(s))`);

    for (const scenario of SCENARIOS) {
      const start = (await stub.requests()).length;
      if (scenario.send !== undefined) {
        const answer = await scenario.send(proxy.base, login.inferenceKey);
        if (answer.status !== scenario.wantStatus) {
          findings.push({
            kind: "missing-request",
            scenario: scenario.name,
            request: "the client request",
            detail: `answered ${answer.status}, want ${scenario.wantStatus}: ${JSON.stringify(answer.body).slice(0, 400)}`,
          });
        }
      }
      const slice = (await stub.requests()).slice(start);
      requestsTotal += slice.length;
      const found = compareScenario(scenario.name, slice, scenario.pins, ctx);
      findings.push(...found);
      console.log(`parity: ${scenario.name}: ${found.length === 0 ? "ok" : `${found.length} finding(s)`} (${slice.length} upstream request(s))`);
    }

    if (findings.length > 0) {
      console.error(`parity: FAIL: ${findings.length} finding(s):`);
      for (const finding of findings) {
        console.error(`  [${finding.kind}] ${finding.scenario} — ${finding.request}: ${finding.detail}`);
      }
      process.exit(1);
    }
    console.log(`parity: ${requestsTotal} upstream requests across ${SCENARIOS.length + 1} slices, 0 findings`);
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
