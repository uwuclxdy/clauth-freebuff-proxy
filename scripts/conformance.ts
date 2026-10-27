/**
 * The conformance harness driver: spawns the stub upstream
 * (scripts/stub-freebuff.ts) and the real proxy process (src/index.ts,
 * `serve`) with the origin pinned to the stub through the src/origins.ts env
 * seam, logs a fresh account in through the paste door, then drives a built
 * `clauth proxy check` against the proxy in safe and --destructive modes.
 *
 * Asserted per run: exit 0, the exact green tail (`conformant: N checks
 * passed`), no skipped checks, no credential (admin token, inference key, the
 * freebuff token) anywhere in the check's output on any path (a red run
 * scrubs its embedded output, naming the class), at least one chat request
 * seen by the stub, no unmatched stub route, and — after the destructive run —
 * the account gone.
 *
 * The clauth binary comes from CLAUTH_BIN or, on this box, ~/.cargo/bin/clauth;
 * CI fetches the release asset pinned in .github/workflows/ci.yml. With
 * neither present the leg fails loudly — never a silent skip.
 */

import { existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  HarnessError,
  HarnessRuntime,
  adminAuthOf,
  freePort,
  makeRunDirs,
  pasteLogin,
  startProxy,
  startStub,
  tailOf,
  waitFor,
  writeSecretFile,
} from "./harness.ts";

const SCRATCH_ROOT = process.env.CONFORMANCE_SCRATCH_DIR || join(tmpdir(), "clauth-freebuff-proxy-conformance");
const FREEBUFF_TOKEN = "fa82b5c1-e39d-4c7a-961f-d2b3c4e5f6a7";
const FIGURES_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 300_000;

interface GreenRun {
  mode: string;
  stdout: string;
  stderr: string;
  exit: number;
}

async function main(): Promise<void> {
  const bin = process.env.CLAUTH_BIN ?? join(homedir(), ".cargo", "bin", "clauth");
  if (!existsSync(bin) || !statSync(bin).isFile()) {
    throw new HarnessError(`no clauth binary at ${bin} (set CLAUTH_BIN; CI fetches the release asset pinned in .github/workflows/ci.yml).`);
  }

  const runtime = new HarnessRuntime(SCRATCH_ROOT);
  runtime.installSignalHandlers();
  try {
    const dirs = makeRunDirs(runtime, SCRATCH_ROOT);
    const adminToken = randomBytes(32).toString("hex");
    writeSecretFile(dirs.adminTokenFile, adminToken + "\n");

    // Every credential class the run can emit, scrubbed from any embedded
    // output on every red path; the inference key joins once login hands it over.
    const secrets: [string, string][] = [
      ["admin token", adminToken],
      ["freebuff token", FREEBUFF_TOKEN],
    ];
    const leakClassesOf = (text: string): string[] => secrets.filter(([, value]) => text.includes(value)).map(([what]) => what);
    const scrub = (text: string): string => {
      let out = text;
      for (const [what, value] of secrets) out = out.split(value).join(`<${what} withheld>`);
      return out;
    };

    const stub = await startStub(runtime, dirs.runDir);
    const proxy = await startProxy(runtime, dirs, { port: freePort(), upstreamBase: stub.base });
    const { accountId, inferenceKey } = await pasteLogin(proxy.base, adminToken, FREEBUFF_TOKEN);
    secrets.push(["inference key", inferenceKey]);
    const keyPath = join(dirs.runDir, "inference-key");
    writeSecretFile(keyPath, inferenceKey + "\n");

    // The usage cadence polls at 1000 ms; wait out the first tick so the check
    // sees figures (and the destructive claim action has a target).
    await waitFor(async () => {
      try {
        const res = await fetch(`${proxy.base}/clauth/v1/usage?account=${accountId}`, {
          headers: adminAuthOf(adminToken),
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) return false;
        const body = (await res.json()) as { accounts?: { figures?: unknown[] }[] };
        return (body.accounts?.[0]?.figures?.length ?? 0) > 0;
      } catch {
        return false;
      }
    }, "the first usage figures poll", FIGURES_TIMEOUT_MS);

    const runCheck = (mode: "safe" | "destructive"): GreenRun => {
      const args = [bin, "proxy", "check", proxy.base, "--admin-token-file", dirs.adminTokenFile, "--key-file", keyPath];
      if (mode === "destructive") args.push("--destructive", accountId);
      const out = spawnSync(args[0]!, args.slice(1), {
        encoding: "utf8",
        timeout: CHECK_TIMEOUT_MS,
        // the check never reads a real profile for a URL target; keep it off the real HOME anyway
        env: { ...process.env, HOME: dirs.runDir },
      });
      return { mode, stdout: out.stdout ?? "", stderr: out.stderr ?? "", exit: out.status ?? -1 };
    };

    const assertGreen = (run: GreenRun): void => {
      const output = run.stdout + run.stderr;
      const leaks = leakClassesOf(output);
      if (run.exit !== 0) {
        throw new HarnessError(
          scrub(`${run.mode} check exited ${run.exit}:\n${run.stdout}\n${run.stderr}\nproxy log tail:\n${tailOf(proxy.child.logPath)}\nstub log tail:\n${tailOf(stub.child.logPath)}`) +
            (leaks.length > 0 ? `\nscrubbed credential classes: ${leaks.join(", ")}` : ""),
        );
      }
      const lines = run.stdout.split("\n").filter((line) => line.trim() !== "");
      const last = lines.at(-1) ?? "";
      if (!/^conformant: \d+ checks passed$/.test(last)) {
        throw new HarnessError(scrub(`${run.mode} check's green tail is ${JSON.stringify(last)}:\n${run.stdout}\n${run.stderr}`));
      }
      if (output.includes("skipped:")) {
        throw new HarnessError(scrub(`${run.mode} check skipped checks (the harness must cover them):\n${run.stdout}\n${run.stderr}`));
      }
      if (leaks.length > 0) {
        throw new HarnessError(`${run.mode} check output leaked ${leaks.join(", ")} (values withheld)`);
      }
    };

    const safe = runCheck("safe");
    assertGreen(safe);
    const safeTail = safe.stdout.split("\n").filter((line) => line !== "").slice(-3).join("\n");

    const destructive = runCheck("destructive");
    assertGreen(destructive);
    const destructiveTail = destructive.stdout.split("\n").filter((line) => line !== "").slice(-3).join("\n");

    // The destructive run deleted the account; confirm it is gone.
    const accountsRes = await fetch(`${proxy.base}/clauth/v1/accounts`, { headers: adminAuthOf(adminToken), signal: AbortSignal.timeout(5_000) });
    const accounts = (await accountsRes.json()) as { accounts?: { id: string }[] };
    if ((accounts.accounts ?? []).some((account) => account.id === accountId)) {
      throw new HarnessError(`account ${JSON.stringify(accountId)} still listed after the destructive delete`);
    }

    // The chat path ran end to end, and the stub saw no unpinned route.
    const statsRes = await fetch(`${stub.base}/__stub/stats`, { signal: AbortSignal.timeout(5_000) });
    const stats = (await statsRes.json()) as { requests: number; unmatched: number; chats: number };
    if (stats.chats < 1) {
      throw new HarnessError(`no chat request reached the stub (stats ${JSON.stringify(stats)})`);
    }
    if (stats.unmatched !== 0) {
      throw new HarnessError(scrub(`the stub answered ${String(stats.unmatched)} unpinned routes; stub log tail:\n${tailOf(stub.child.logPath)}`));
    }

    console.log(`conformance: stub ${stub.base}, proxy ${proxy.base}`);
    console.log(`safe: ${safeTail}`);
    console.log(`destructive: ${destructiveTail}`);
    console.log(`stub stats: ${JSON.stringify(stats)}`);
    console.log("conformance: PASS");
  } finally {
    await runtime.teardown();
  }
}

try {
  await main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`conformance: FAIL: ${message}`);
  process.exit(1);
}
