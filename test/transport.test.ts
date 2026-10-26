import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { upstreamBase } from "../src/origins.ts";
import { upstreamHeaders } from "../src/transport.ts";

// The three header sets are: one base set
// (Accept, Accept-Encoding, Connection, Host, Authorization) plus a per-class
// user agent. The origin seam reads the env at each access, so every test pins
// its own upstream.

const ORIGINAL_BASE = process.env.FREEBUFF_UPSTREAM_BASE_URL;

beforeAll(() => {
  process.env.FREEBUFF_UPSTREAM_BASE_URL = "https://www.codebuff.com";
});

afterAll(() => {
  if (ORIGINAL_BASE === undefined) delete process.env.FREEBUFF_UPSTREAM_BASE_URL;
  else process.env.FREEBUFF_UPSTREAM_BASE_URL = ORIGINAL_BASE;
});

describe("origin seam", () => {
  test("bare codebuff.com normalizes to www; the default is the real origin", () => {
    process.env.FREEBUFF_UPSTREAM_BASE_URL = "codebuff.com";
    expect(upstreamBase()).toBe("https://www.codebuff.com");
    process.env.FREEBUFF_UPSTREAM_BASE_URL = "http://127.0.0.1:9/";
    expect(upstreamBase()).toBe("http://127.0.0.1:9");
    delete process.env.FREEBUFF_UPSTREAM_BASE_URL;
    expect(upstreamBase()).toBe("https://www.codebuff.com");
    process.env.FREEBUFF_UPSTREAM_BASE_URL = "https://www.codebuff.com";
  });
});

describe("header sets", () => {
  test("every class shares the base set and carries Bearer auth", () => {
    for (const headerClass of ["api", "chat", "cli"] as const) {
      const headers = upstreamHeaders(headerClass, "tok-1");
      expect(headers).toContainEqual(["Accept", "*/*"]);
      expect(headers).toContainEqual(["Accept-Encoding", "gzip, deflate"]);
      expect(headers).toContainEqual(["Connection", "keep-alive"]);
      expect(headers).toContainEqual(["Host", "www.codebuff.com"]);
      expect(headers).toContainEqual(["Authorization", "Bearer tok-1"]);
    }
  });

  test("the user agent is the one difference between the classes", () => {
    expect(upstreamHeaders("api", "t").find(([name]) => name === "User-Agent")).toEqual(["User-Agent", "Bun/1.3.11"]);
    expect(upstreamHeaders("chat", "t").find(([name]) => name === "User-Agent")).toEqual([
      "User-Agent",
      "ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.20 runtime/browser",
    ]);
    expect(upstreamHeaders("cli", "t").find(([name]) => name === "User-Agent")).toEqual(["User-Agent", "Freebuff-CLI/0.0.105"]);
  });

  test("extra headers ride last without displacing the base set", () => {
    const headers = upstreamHeaders("cli", "t", [["x-freebuff-model", "minimax/minimax-m2.7"]]);
    expect(headers[0]).toEqual(["Accept", "*/*"]);
    expect(headers.filter(([name]) => name === "Host")).toEqual([["Host", "www.codebuff.com"]]);
    expect(headers.at(-1)).toEqual(["x-freebuff-model", "minimax/minimax-m2.7"]);
  });
});
