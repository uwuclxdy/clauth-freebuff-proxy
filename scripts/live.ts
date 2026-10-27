/**
 * The live verification driver: the real proxy against the real upstream, with
 * a recording relay in front of it so every upstream request and answer lands
 * in `docs/research/<date>-live/run.jsonl`, the Authorization value redacted.
 * One paste login, one non-streaming chat, one streaming chat, one figures
 * read, then teardown.
 *
 * The token comes from FREEBUFF_TOKEN_FILE, never argv, never stdout, and is
 * proxied by `pasteLogin` exactly once, as any other client would.
 *
 *   FREEBUFF_TOKEN_FILE=~/.config/clauth-freebuff/token bun scripts/live.ts
 *
 * A stub dial (`FREEBUFF_LIVE_UPSTREAM=...`) exercises the plumbing offline;
 * it writes a `-stub` capture, never the live one. The default is the real
 * origin.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_UPSTREAM, normalizeUpstreamBase } from "../src/origins.ts";
import {
  HarnessError,
  HarnessRuntime,
  adminAuthOf,
  freePort,
  makeRunDirs,
  pasteLogin,
  startProxy,
  writeSecretFile,
} from "./harness.ts";

const MODEL = "minimax/minimax-m2.7";
const ADMIN_TOKEN = randomBytes(32).toString("hex");
export const BODY_CAP = 1 << 20;
const SCRATCH_ROOT = process.env.LIVE_SCRATCH_DIR ?? join(tmpdir(), "clauth-freebuff-live");
const RESEARCH_ROOT = join(import.meta.dir, "..", "docs", "research");
const HOP_HEADERS = ["host", "connection", "content-length"];
const FRAMING_HEADERS = ["content-encoding", "content-length", "transfer-encoding"];
const REQUIRED_FIGURES = ["session", "stats"];

export interface TeeRecord {
  at: string;
  direction: "request" | "response";
  method: string;
  path: string;
  status?: number;
  headers: Array<[string, string]>;
  body: string;
  truncated?: boolean;
}

export function redactedHeaders(headers: Headers): Array<[string, string]> {
  return [...headers.entries()].map(([name, value]) => (name.toLowerCase() === "authorization" ? [name, "<redacted>"] : [name, value]));
}

export function capped(body: string): { body: string; truncated?: boolean } {
  return body.length > BODY_CAP ? { body: body.slice(0, BODY_CAP), truncated: true } : { body };
}

export function scrubSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) if (secret !== "") out = out.split(secret).join("<redacted>");
  return out;
}

export interface CaptureMode {
  live: boolean;
  dirSuffix: string;
  title: string;
}

export function captureMode(origin: string): CaptureMode {
  const live = origin === DEFAULT_UPSTREAM;
  return { live, dirSuffix: live ? "" : "-stub", title: live ? "live verification" : "stub plumbing run" };
}

/** The recording relay: the upstream sees the proxy's own bytes, and both
 * sides are teed into `records` before the answer is handed back. */
export function startRelay(origin: string, records: TeeRecord[]): { base: string; stop: () => void } {
  const port = freePort();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const method = req.method;
      const requestBody = method === "GET" || method === "HEAD" ? "" : await req.text();
      const headers = new Headers(req.headers);
      for (const hop of HOP_HEADERS) headers.delete(hop);
      records.push({
        at: new Date().toISOString(),
        direction: "request",
        method,
        path: url.pathname,
        headers: redactedHeaders(req.headers),
        ...capped(requestBody),
      });

      // a redirect is followed here so the decisive exchange stays in the capture
      const upstream = await fetch(`${origin}${url.pathname}${url.search}`, {
        method,
        headers,
        body: requestBody === "" ? undefined : requestBody,
      });
      // buffered so the capture is verbatim; a live chat answer is small
      const text = await upstream.text();
      // fetch() already decompressed the body, so the framing headers would lie
      const responseHeaders = new Headers(upstream.headers);
      for (const framing of FRAMING_HEADERS) responseHeaders.delete(framing);
      records.push({
        at: new Date().toISOString(),
        direction: "response",
        method,
        path: url.pathname,
        status: upstream.status,
        headers: redactedHeaders(responseHeaders),
        ...capped(text),
      });
      return new Response(text, { status: upstream.status, headers: responseHeaders });
    },
  });
  return { base: `http://127.0.0.1:${port}`, stop: () => server.stop(true) };
}

async function postMessages(opts: { base: string; key: string; stream: boolean }): Promise<{ status: number; body: string }> {
  const res = await fetch(`${opts.base}/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${opts.key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 64,
      messages: [{ role: "user", content: "Reply with the single word: live" }],
      ...(opts.stream ? { stream: true } : {}),
    }),
    signal: AbortSignal.timeout(180_000),
  });
  return { status: res.status, body: await res.text() };
}

function assertAnthropicSse(text: string): void {
  for (const event of ["message_start", "content_block_delta", "message_stop"]) {
    if (!text.includes(`event: ${event}`)) throw new HarnessError(`streaming chat never sent ${event}`);
  }
}

export async function readFigures(base: string, secrets: string[]): Promise<unknown[]> {
  const res = await fetch(`${base}/clauth/v1/usage`, { headers: adminAuthOf(ADMIN_TOKEN), signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (res.status !== 200) throw new HarnessError(`usage read answered ${res.status}: ${scrubSecrets(text.slice(0, 500), secrets)}`);
  const figures = (JSON.parse(text) as { accounts?: Array<{ figures?: Array<{ id?: string }> }> }).accounts?.[0]?.figures ?? [];
  const ids = figures.map((figure) => figure.id);
  for (const required of REQUIRED_FIGURES) {
    if (!ids.includes(required)) throw new HarnessError(`usage read carried no ${required} figure`);
  }
  return figures;
}

export function captureDir(mode: CaptureMode, researchRoot = RESEARCH_ROOT): string {
  return join(researchRoot, `${new Date().toISOString().slice(0, 10)}-live${mode.dirSuffix}`);
}

/** One run's evidence is never replaced by another: a second capture on the
 * same day fails before it spends anything upstream. */
export function refuseExistingCapture(dir: string): void {
  if (existsSync(join(dir, "run.jsonl"))) throw new HarnessError(`a capture already sits at ${dir}; refusing to overwrite it`);
}

export function writeCapture(opts: { records: TeeRecord[]; origin: string; figures: unknown[]; statuses: { plain: number; streamed: number }; mode: CaptureMode }, dir: string): void {
  refuseExistingCapture(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.jsonl"), opts.records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  writeFileSync(
    join(dir, "summary.md"),
    [
      `# ${opts.mode.title}, ${new Date().toISOString().slice(0, 10)}`,
      "",
      `Origin: \`${opts.origin}\`. Model: \`${MODEL}\`.`,
      "",
      `- upstream exchanges captured: ${opts.records.filter((r) => r.direction === "request").length} requests, ${opts.records.filter((r) => r.direction === "response").length} answers`,
      `- non-streaming chat: ${opts.statuses.plain}`,
      `- streaming chat: ${opts.statuses.streamed}, Anthropic SSE events present`,
      `- figures: ${JSON.stringify(opts.figures)}`,
      "",
      "Raw request and answer bodies: `run.jsonl` beside this file, Authorization redacted.",
    ].join("\n") + "\n",
  );
}

async function main(): Promise<void> {
  const tokenFile = process.env.FREEBUFF_TOKEN_FILE;
  if (tokenFile === undefined || tokenFile === "") throw new HarnessError("FREEBUFF_TOKEN_FILE is required");
  const token = readFileSync(tokenFile, "utf8").trim();
  if (token === "") throw new HarnessError(`the token file ${tokenFile} is empty`);
  const origin = normalizeUpstreamBase(process.env.FREEBUFF_LIVE_UPSTREAM ?? DEFAULT_UPSTREAM);
  const mode = captureMode(origin);
  const dir = captureDir(mode);
  refuseExistingCapture(dir);

  const runtime = new HarnessRuntime(SCRATCH_ROOT);
  runtime.installSignalHandlers();
  const records: TeeRecord[] = [];
  const relay = startRelay(origin, records);
  try {
    const dirs = makeRunDirs(runtime, SCRATCH_ROOT);
    writeSecretFile(dirs.adminTokenFile, ADMIN_TOKEN);
    const proxy = await startProxy(runtime, dirs, { port: freePort(), upstreamBase: relay.base });

    const login = await pasteLogin(proxy.base, ADMIN_TOKEN, token);
    const secrets = [token, ADMIN_TOKEN, login.inferenceKey];
    const plain = await postMessages({ base: proxy.base, key: login.inferenceKey, stream: false });
    if (plain.status !== 200) throw new HarnessError(`non-streaming chat answered ${plain.status}: ${scrubSecrets(plain.body.slice(0, 500), secrets)}`);
    const streamed = await postMessages({ base: proxy.base, key: login.inferenceKey, stream: true });
    if (streamed.status !== 200) throw new HarnessError(`streaming chat answered ${streamed.status}: ${scrubSecrets(streamed.body.slice(0, 500), secrets)}`);
    assertAnthropicSse(streamed.body);
    const figures = await readFigures(proxy.base, secrets);

    writeCapture({ records, origin, figures, statuses: { plain: plain.status, streamed: streamed.status }, mode }, dir);
    process.stdout.write(`${mode.title} captured: ${records.filter((r) => r.direction === "request").length} upstream requests -> ${dir}\n`);
  } finally {
    relay.stop();
    await runtime.teardown();
  }
}

if (import.meta.main) {
  void main().catch((err: unknown) => {
    process.stderr.write(`live run failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
