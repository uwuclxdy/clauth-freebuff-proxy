/**
 * The login plane, in the freebuff CLI's own shape: the proxy asks for a
 * login code keyed by a fresh fingerprint, hands the client the upstream login
 * URL, and polls the code's status until the upstream answers with the
 * account's auth token. A pasted token takes the same validation and completes
 * the same way, so both doors end on one bare uuid checked by a
 * status-code-only streak probe.
 */

import { randomBytes } from "node:crypto";
import {
  AdapterError,
  type LoginCancelContext,
  type LoginPasteContext,
  type LoginPollContext,
  type LoginPollResult,
  type LoginStartContext,
  type LoginStartResult,
} from "clauth-proxy-core";
import { CLI_LOGIN_CODE_PATH, CLI_LOGIN_STATUS_PATH, STREAK_PATH, upstreamRequestJson } from "./transport.ts";

/** The CLI polls its login status every five seconds. */
export const POLL_INTERVAL_MS = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LoginHandle {
  fingerprintId: string;
  fingerprintHash: string;
  expiresAt: number;
}

function readLoginHandle(upstream: unknown): LoginHandle | null {
  if (typeof upstream !== "object" || upstream === null) return null;
  const handle = upstream as Record<string, unknown>;
  const fingerprintId = handle["fingerprintId"];
  const fingerprintHash = handle["fingerprintHash"];
  const expiresAt = handle["expiresAt"];
  if (typeof fingerprintId !== "string" || typeof fingerprintHash !== "string" || typeof expiresAt !== "number") return null;
  return { fingerprintId, fingerprintHash, expiresAt };
}

interface LoginCode {
  loginUrl: string;
  fingerprintHash: string;
  expiresAt: number;
}

function readLoginCode(body: unknown): LoginCode | null {
  if (typeof body !== "object" || body === null) return null;
  const code = body as Record<string, unknown>;
  const loginUrl = code["loginUrl"];
  const fingerprintHash = code["fingerprintHash"];
  const expiresAt = code["expiresAt"];
  if (typeof loginUrl !== "string" || loginUrl === "") return null;
  if (typeof fingerprintHash !== "string" || fingerprintHash === "") return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  return { loginUrl, fingerprintHash, expiresAt };
}

/** The auth token the status answer carries once the browser side has signed in. */
function userToken(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const user = (body as Record<string, unknown>)["user"];
  if (typeof user !== "object" || user === null) return null;
  const token = (user as Record<string, unknown>)["authToken"];
  return typeof token === "string" && token !== "" ? token : null;
}

export async function loginStart(_ctx: LoginStartContext): Promise<LoginStartResult> {
  const fingerprintId = `clauth-freebuff-proxy-${randomBytes(12).toString("hex")}`;
  const { status, body } = await upstreamRequestJson({
    path: CLI_LOGIN_CODE_PATH,
    method: "POST",
    token: null,
    headerClass: "api",
    body: { fingerprintId },
  });
  if (status !== 200) throw new AdapterError("upstream_unavailable", `login: the upstream answered ${status} for a login code`);
  const code = readLoginCode(body);
  if (code === null) throw new AdapterError("upstream_unavailable", "login: the upstream answer carried no login code");
  return {
    url: code.loginUrl,
    modes: ["poll", "paste"],
    poll_interval_ms: POLL_INTERVAL_MS,
    expires_at: new Date(code.expiresAt).toISOString(),
    upstream: { fingerprintId, fingerprintHash: code.fingerprintHash, expiresAt: code.expiresAt },
  };
}

/** One status poll. The upstream answers 401 until the browser side signs in. */
export async function loginPoll(ctx: LoginPollContext): Promise<LoginPollResult> {
  const handle = readLoginHandle(ctx.upstream);
  if (handle === null) return { state: "pending" };
  const query = new URLSearchParams({
    fingerprintId: handle.fingerprintId,
    fingerprintHash: handle.fingerprintHash,
    expiresAt: String(handle.expiresAt),
  });
  const { status, body } = await upstreamRequestJson({
    path: `${CLI_LOGIN_STATUS_PATH}?${query.toString()}`,
    method: "GET",
    token: null,
    headerClass: "api",
  });
  if (status === 401) return { state: "pending" };
  if (status !== 200) throw new AdapterError("upstream_unavailable", `login: the status poll answered ${status}`);
  const token = userToken(body);
  if (token === null) return { state: "pending" };
  if (!UUID_RE.test(token)) return { state: "failed", error: "code_invalid" };
  try {
    await probeToken(token);
  } catch (err) {
    if (err instanceof ProbeRejected) return { state: "failed", error: err.code };
    throw err;
  }
  return completeLogin(token);
}

class ProbeRejected extends Error {
  constructor(readonly code: "code_invalid" | "upstream_unavailable") {
    super(code);
  }
}

/** Status-code-only probe of the streak route; a side effect is never sent. */
async function probeToken(token: string): Promise<void> {
  const { status } = await upstreamRequestJson({ path: STREAK_PATH, method: "GET", token, headerClass: "api" });
  if (status === 200) return;
  if (status === 401) throw new ProbeRejected("code_invalid");
  if (status === 404) throw new ProbeRejected("upstream_unavailable");
  throw new Error(`streak probe answered ${status}`);
}

/** The one completion both doors share: the probed token becomes the account. */
function completeLogin(token: string): LoginPollResult {
  return {
    state: "done",
    identity: token,
    label: maskedLabel(token),
    plans: [{ id: "free", label: "Free" }],
    blob: token,
  };
}

export async function loginPaste(ctx: LoginPasteContext): Promise<LoginPollResult> {
  const code = ctx.code.trim();
  if (!UUID_RE.test(code)) return { state: "failed", error: "code_invalid" };
  try {
    await probeToken(code);
  } catch (err) {
    if (err instanceof ProbeRejected) return { state: "failed", error: err.code };
    throw err;
  }
  return completeLogin(code);
}

/** `freebuff fa82…f6a7` — the token's own ends, never the whole uuid. */
export function maskedLabel(token: string): string {
  return `freebuff ${token.slice(0, 4)}…${token.slice(-4)}`;
}

export async function loginCancel(_ctx: LoginCancelContext): Promise<void> {}

/** The persisted login blob is the token itself; anything else reads as a dead login. */
export function tokenFromBlob(blob: unknown): string | null {
  return typeof blob === "string" && blob !== "" ? blob : null;
}
