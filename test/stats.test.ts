import { describe, expect, test } from "bun:test";
import { dropStats, recordTokens, recordUpstream, statsCounters } from "../src/stats.ts";

// The stats figure is the proxy's own record: per-account counters, epoch at
// module init (the counters are process-lifetime, so `since` must say so).

describe("stats counters", () => {
  test("the epoch is the module's init time, not any account's creation", () => {
    const counters = statsCounters("acct-epoch");
    expect(counters.since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const other = statsCounters("acct-epoch-other");
    expect(other.since).toBe(counters.since);
  });

  test("upstream requests count attempted plus the outcome, latency averaged", () => {
    recordUpstream("acct-count", true, 100);
    recordUpstream("acct-count", true, 200);
    recordUpstream("acct-count", false);
    const counters = statsCounters("acct-count") as { requests: Record<string, number>; mean_latency_ms: number | null };
    expect(counters.requests).toEqual({ attempted: 3, succeeded: 2, failed: 1, cancelled: 0 });
    expect(counters.mean_latency_ms).toBe(150);
  });

  test("tokens accumulate; a dropped account's counters are gone", () => {
    recordTokens("acct-tokens", { input: 10, output: 2, cache_read: 3 });
    recordTokens("acct-tokens", { input: 1 });
    const counters = statsCounters("acct-tokens") as { tokens: Record<string, number> };
    expect(counters.tokens).toEqual({ input: 11, output: 2, cache_read: 3, cache_creation: 0 });
    dropStats("acct-tokens");
    expect((statsCounters("acct-tokens") as { tokens: Record<string, number> }).tokens.input).toBe(0);
  });
});
