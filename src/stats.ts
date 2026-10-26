/**
 * The proxy-side request counters behind the `stats` figure: per account, for
 * the process lifetime, epoch at module init. Freebuff exposes no request
 * counters upstream, so this figure is the proxy's own record of what it
 * attempted on an account's behalf; a restart honestly restarts the counters.
 */

export interface ObservedTokens {
  input?: number | undefined;
  output?: number | undefined;
  cache_read?: number | undefined;
  cache_creation?: number | undefined;
}

const EPOCH = new Date().toISOString();

interface AccountStats {
  attempted: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  latencyMsSum: number;
  latencyCount: number;
  tokens: { input: number; output: number; cache_read: number; cache_creation: number };
}

const stats = new Map<string, AccountStats>();

function statsEntry(accountId: string): AccountStats {
  let entry = stats.get(accountId);
  if (entry === undefined) {
    entry = {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      latencyMsSum: 0,
      latencyCount: 0,
      tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
    };
    stats.set(accountId, entry);
  }
  return entry;
}

/**
 * Record one upstream request the chat chain made on the account's behalf —
 * session create/poll/end, run START/FINISH, the chat itself. The usage read's
 * own GET stays uncounted: housekeeping is not the account's traffic.
 */
export function recordUpstream(accountId: string, ok: boolean, latencyMs?: number): void {
  const entry = statsEntry(accountId);
  entry.attempted += 1;
  if (ok) entry.succeeded += 1;
  else entry.failed += 1;
  if (latencyMs !== undefined && Number.isFinite(latencyMs)) {
    entry.latencyMsSum += latencyMs;
    entry.latencyCount += 1;
  }
}

/** Record usage tokens a chat answer carried. */
export function recordTokens(accountId: string, tokens: ObservedTokens): void {
  const entry = statsEntry(accountId);
  if (tokens.input !== undefined) entry.tokens.input += tokens.input;
  if (tokens.output !== undefined) entry.tokens.output += tokens.output;
  if (tokens.cache_read !== undefined) entry.tokens.cache_read += tokens.cache_read;
  if (tokens.cache_creation !== undefined) entry.tokens.cache_creation += tokens.cache_creation;
}

/** Forget one account's counters, on account delete. */
export function dropStats(accountId: string): void {
  stats.delete(accountId);
}

/** The `stats` figure body, without its envelope fields. */
export function statsCounters(accountId: string): Record<string, unknown> {
  const entry = statsEntry(accountId);
  return {
    since: EPOCH,
    requests: {
      attempted: entry.attempted,
      succeeded: entry.succeeded,
      failed: entry.failed,
      cancelled: entry.cancelled,
    },
    mean_latency_ms: entry.latencyCount === 0 ? null : Math.round(entry.latencyMsSum / entry.latencyCount),
    tokens: { ...entry.tokens },
  };
}
