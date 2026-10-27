/**
 * Shared machinery for the harness drivers (scripts/conformance.ts,
 * scripts/parity.ts, scripts/live.ts): loopback ports, 0600 secret files,
 * logged child spawns, one bounded wait, the paste login every driver needs,
 * and the signal-safe teardown that installs before any child exists — a
 * Ctrl-C or CI cancel must not orphan a proxy still serving with its valid
 * admin-token file.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmdirSync, rmSync, statSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const STUB_PATH = join(import.meta.dir, "stub-freebuff.ts");
const POLL_MS = 300;

export class HarnessError extends Error {}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function freePort(): number {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  const port = (server.address() as { port: number }).port;
  server.close();
  return port;
}

/** A secret alone in a 0600 file, never on argv. node:fs has no
 * write-with-mode single call; open with the mode then write. */
export function writeSecretFile(path: string, value: string): void {
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, value);
  } finally {
    closeSync(fd);
  }
}

export interface Child {
  proc: ChildProcess;
  logPath: string;
}

export function spawnLogged(name: string, argv: string[], env: NodeJS.ProcessEnv, runDir: string): Child {
  const logPath = join(runDir, `${name}.log`);
  const logFd = openSync(logPath, "a", 0o600);
  const proc = spawn(argv[0]!, argv.slice(1), { env, stdio: ["ignore", logFd, logFd] });
  proc.once("exit", () => closeSync(logFd));
  return { proc, logPath };
}

export async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new HarnessError(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

export function tailOf(path: string, lines = 15): string {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const all = text.split("\n").filter((line) => line !== "");
  return all.slice(-lines).join("\n");
}

export class HarnessRuntime {
  readonly children: Child[] = [];

  constructor(readonly scratchRoot: string) {}

  private created: string | null = null;

  markCreated(dir: string): void {
    this.created = dir;
  }

  private teardownPromise: Promise<void> | null = null;

  /** One memoized pass: stops the children, removes the run dir on every exit
   * path; nothing secret outlives the process. A repeat signal is absorbed —
   * the first teardown is running and bounded. */
  readonly teardown = (): Promise<void> => {
    this.teardownPromise ??= (async () => {
      for (const child of this.children) child.proc.kill("SIGTERM");
      await Promise.race([
        Promise.all(this.children.map((child) => new Promise<void>((resolve) => child.proc.once("exit", () => resolve())))),
        sleep(5_000),
      ]);
      for (const child of this.children) child.proc.kill("SIGKILL");
      if (this.created !== null) rmSync(this.created, { recursive: true, force: true });
      // rmdir fails while the root holds anything else (a pre-existing or
      // foreign dir) — failing closed keeps it
      try {
        rmdirSync(this.scratchRoot);
      } catch {
        // not ours to remove
      }
    })();
    return this.teardownPromise;
  };

  installSignalHandlers(): void {
    let interrupted: NodeJS.Signals | null = null;
    const onSignal = (signal: NodeJS.Signals): void => {
      if (interrupted !== null) return;
      interrupted = signal;
      console.error(`harness: ${signal}, stopping children${this.created === null ? "" : ` and removing ${this.created}`}`);
      void this.teardown().then(
        () => process.exit(signal === "SIGINT" ? 130 : 143),
        (err: unknown) => {
          console.error(`harness: teardown after ${signal} failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        },
      );
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
}

export interface RunDirs {
  runDir: string;
  stateDir: string;
  adminTokenFile: string;
}

export function makeRunDirs(runtime: HarnessRuntime, scratchRoot: string): RunDirs {
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const runDir = mkdtempSync(join(scratchRoot, "run-"));
  chmodSync(runDir, 0o700);
  const stateDir = join(runDir, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  runtime.markCreated(runDir);
  return { runDir, stateDir, adminTokenFile: join(runDir, "admin-token") };
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Array<[string, string]>;
  bodyRaw: string | null;
  at: number;
}

export interface StubHandle {
  child: Child;
  port: number;
  base: string;
  /** Every recorded freebuff request so far, oldest first. */
  requests: () => Promise<RecordedRequest[]>;
}

export async function startStub(runtime: HarnessRuntime, runDir: string): Promise<StubHandle> {
  const port = freePort();
  const child = spawnLogged("stub", [process.execPath, STUB_PATH], { ...process.env, STUB_PORT: String(port) }, runDir);
  runtime.children.push(child);
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    try {
      return (await fetch(`${base}/__stub/healthz`, { signal: AbortSignal.timeout(1_000) })).ok;
    } catch {
      return false;
    }
  }, "the stub upstream to boot", 15_000);
  return {
    child,
    port,
    base,
    requests: async () => {
      const res = await fetch(`${base}/__stub/requests`, { signal: AbortSignal.timeout(10_000) });
      return ((await res.json()) as { requests: RecordedRequest[] }).requests;
    },
  };
}

export interface ProxyHandle {
  child: Child;
  base: string;
}

export async function startProxy(
  runtime: HarnessRuntime,
  dirs: RunDirs,
  opts: { port: number; upstreamBase: string },
): Promise<ProxyHandle> {
  const child = spawnLogged(
    "proxy",
    [process.execPath, join(REPO_ROOT, "src", "index.ts"), "serve"],
    {
      ...process.env,
      CLAUTH_PROXY_BIND: `127.0.0.1:${opts.port}`,
      CLAUTH_PROXY_STATE_DIR: dirs.stateDir,
      CLAUTH_PROXY_ADMIN_TOKEN_FILE: dirs.adminTokenFile,
      FREEBUFF_UPSTREAM_BASE_URL: opts.upstreamBase,
    },
    dirs.runDir,
  );
  runtime.children.push(child);
  const base = `http://127.0.0.1:${opts.port}`;
  await waitFor(async () => {
    try {
      return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) })).ok;
    } catch {
      return false;
    }
  }, "the proxy to serve /health", 20_000);
  if (child.proc.exitCode !== null) throw new HarnessError("the proxy exited during boot");
  return { child, base };
}

export interface LoggedIn {
  accountId: string;
  inferenceKey: string;
}

/** The paste door: the freebuff token arrives as the code, validated by the
 * side-effect-free streak probe before the flow completes. */
export async function pasteLogin(proxyBase: string, adminToken: string, code: string): Promise<LoggedIn> {
  const auth = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" };
  const startRes = await fetch(`${proxyBase}/clauth/v1/accounts/login`, {
    method: "POST",
    headers: auth,
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  });
  if (startRes.status !== 201) throw new HarnessError(`login start answered ${startRes.status}: ${await startRes.text()}`);
  const start = (await startRes.json()) as { flow: string };
  const pasteRes = await fetch(`${proxyBase}/clauth/v1/accounts/login/${start.flow}`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(10_000),
  });
  const paste = (await pasteRes.json()) as { state: string; account?: { id: string }; inference_key?: string; error?: string };
  if (paste.state !== "done" || paste.account === undefined || paste.inference_key === undefined) {
    throw new HarnessError(`paste login did not complete (state ${paste.state}, error ${String(paste.error)})`);
  }
  return { accountId: paste.account.id, inferenceKey: paste.inference_key };
}

export function adminAuthOf(adminToken: string): Record<string, string> {
  return { authorization: `Bearer ${adminToken}` };
}
