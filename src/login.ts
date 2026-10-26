/**
 * The paste login plane: the account token is the freebuff auth uuid, pasted
 * from freebuff.llm.pm after its one-time GitHub OAuth, and validated by a
 * side-effect-free streak probe before the flow completes.
 */

import type {
  LoginCancelContext,
  LoginPasteContext,
  LoginPollContext,
  LoginPollResult,
  LoginStartContext,
  LoginStartResult,
} from "clauth-proxy-core";
import { STREAK_PATH, upstreamRequestJson } from "./transport.ts";

export const LOGIN_URL = "https://freebuff.llm.pm";
const FLOW_TTL_MS = 30 * 60_000;
const POLL_INTERVAL_MS = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loginStart(_ctx: LoginStartContext): Promise<LoginStartResult> {
  return {
    url: LOGIN_URL,
    modes: ["paste"],
    poll_interval_ms: POLL_INTERVAL_MS,
    expires_at: new Date(Date.now() + FLOW_TTL_MS).toISOString(),
    upstream: null,
  };
}

/** The flow has no poll door — the token only arrives pasted. */
export async function loginPoll(_ctx: LoginPollContext): Promise<LoginPollResult> {
  return { state: "pending" };
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

export async function loginPaste(ctx: LoginPasteContext): Promise<LoginPollResult> {
  const code = ctx.code.trim();
  if (!UUID_RE.test(code)) return { state: "failed", error: "code_invalid" };
  try {
    await probeToken(code);
  } catch (err) {
    if (err instanceof ProbeRejected) return { state: "failed", error: err.code };
    throw err;
  }
  return {
    state: "done",
    identity: code,
    label: maskedLabel(code),
    plans: [{ id: "free", label: "Free" }],
    blob: code,
  };
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
