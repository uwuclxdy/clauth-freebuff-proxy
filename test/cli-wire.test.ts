/**
 * The 2026-10-27 client wire: the catalogue that replaces the fixed model
 * table, the CLI system-prompt prefix the free-mode chat gate reads, and the
 * chat metadata the upstream admits.
 */

import { describe, expect, test } from "bun:test";
import { cliSystemPrefix, parseAnthropicRequest, toOpenAiBody } from "../src/convert.ts";
import { CONTRACT_ALIASES, defaultRow, parseCatalogue, resolveRow, slugOf, type Catalogue } from "../src/models.ts";
import { assembleChatBody } from "../src/sessions.ts";

const CATALOGUE_RAW = {
  protocol: 1,
  version: "v0.test.1",
  fetchId: "fbf1.test",
  issuedAt: 1,
  refreshAt: 2,
  rows: [
    {
      key: "m-0000000001",
      handle: "fbm1.aaaa",
      displayName: "MiMo v2.6 Flash Slow",
      access: "open",
      dataUse: "service",
      premium: false,
      sortOrder: 10,
    },
    {
      key: "m-0000000002",
      handle: "fbm1.bbbb",
      displayName: "Claude Haiku 5.5 · 100k context",
      access: "locked",
      dataUse: "service",
      premium: true,
      sortOrder: 20,
    },
  ],
};

describe("the model catalogue", () => {
  test("parses rows into key, handle, label and slug", () => {
    const catalogue = parseCatalogue(CATALOGUE_RAW);
    expect(catalogue).not.toBeNull();
    const row = catalogue!.rows[0]!;
    expect(row.key).toBe("m-0000000001");
    expect(row.handle).toBe("fbm1.aaaa");
    expect(row.label).toBe("MiMo v2.6 Flash Slow");
    expect(row.slug).toBe("mimo-v2-6-flash-slow");
    expect(row.access).toBe("open");
    expect(row.premium).toBe(false);
  });

  test("refuses a body without rows", () => {
    expect(parseCatalogue({ version: "v1" })).toBeNull();
    expect(parseCatalogue(null)).toBeNull();
  });

  test("a catalogue's fetchId is a non-empty string or null", () => {
    expect(parseCatalogue(CATALOGUE_RAW)!.fetchId).toBe("fbf1.test");
    const rows = CATALOGUE_RAW.rows;
    expect(parseCatalogue({ version: "v1", rows })!.fetchId).toBeNull();
    expect(parseCatalogue({ version: "v1", fetchId: "", rows })!.fetchId).toBeNull();
    expect(parseCatalogue({ version: "v1", fetchId: 7, rows })!.fetchId).toBeNull();
  });

  test("slugs collapse every non-alphanumeric run", () => {
    expect(slugOf("Claude Haiku 5.5 · 100k context")).toBe("claude-haiku-5-5-100k-context");
    expect(slugOf("  GPT-6.1 Sol Pro  ")).toBe("gpt-6-1-sol-pro");
  });

  test("resolves by key and by slug", () => {
    const catalogue = parseCatalogue(CATALOGUE_RAW) as Catalogue;
    expect(resolveRow(catalogue, "m-0000000001")?.key).toBe("m-0000000001");
    expect(resolveRow(catalogue, "mimo-v2-6-flash-slow")?.key).toBe("m-0000000001");
    expect(resolveRow(catalogue, "nope")).toBeNull();
  });

  test("the default row is the first open non-premium row", () => {
    const catalogue = parseCatalogue(CATALOGUE_RAW) as Catalogue;
    expect(defaultRow(catalogue)?.key).toBe("m-0000000001");
  });

  test("the contract alias resolves to the default row", () => {
    const catalogue = parseCatalogue(CATALOGUE_RAW) as Catalogue;
    for (const alias of Object.keys(CONTRACT_ALIASES)) {
      expect(resolveRow(catalogue, alias)?.key).toBe(defaultRow(catalogue)?.key);
    }
  });
});

describe("the CLI system-prompt prefix", () => {
  test("is the measured 198-char opening with the given date", () => {
    expect(cliSystemPrefix(new Date(Date.UTC(2026, 9, 27)))).toBe(
      "You are Buffy, the coding agent behind Codebuff. You help users with software engineering tasks: fixing bugs, adding functionality, refactoring, and explaining code.\n\nCurrent date: October 27, 2026.",
    );
  });

  test("leads the client's system prompt", () => {
    const request = parseAnthropicRequest({
      model: "m-0000000001",
      max_tokens: 16,
      system: "You are a test client.",
      messages: [{ role: "user", content: "hi" }],
    });
    const body = toOpenAiBody({ ...request, model: "fbm1.aaaa" });
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content.startsWith("You are Buffy, the coding agent behind Codebuff.")).toBe(true);
    expect(messages[0]?.content.includes("Current date: ")).toBe(true);
    expect(messages[0]?.content.endsWith("You are a test client.")).toBe(true);
  });

  test("is added when the client sent no system prompt", () => {
    const request = parseAnthropicRequest({
      model: "m-0000000001",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    });
    const body = toOpenAiBody({ ...request, model: "fbm1.aaaa" });
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content.startsWith("You are Buffy, the coding agent behind Codebuff.")).toBe(true);
  });

  test("is not duplicated when the client already sent it", () => {
    const prefix = cliSystemPrefix(new Date());
    const request = parseAnthropicRequest({
      model: "m-0000000001",
      max_tokens: 16,
      system: `${prefix}\n\nclient text`,
      messages: [{ role: "user", content: "hi" }],
    });
    const body = toOpenAiBody({ ...request, model: "fbm1.aaaa" });
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect((messages[0]?.content.match(/You are Buffy/g) ?? []).length).toBe(1);
  });
});

describe("the chat metadata", () => {
  test("carries the CLI fields and passes the handle through as the model", () => {
    const body = assembleChatBody({ model: "fbm1.aaaa", messages: [] }, "run-1", "cli:11111111-2222-4333-8444-555555555555", "ff7xdk3ftw");
    expect(body.model).toBe("fbm1.aaaa");
    const metadata = body.codebuff_metadata as Record<string, unknown>;
    expect(metadata.cost_mode).toBe("free");
    expect(metadata.run_id).toBe("run-1");
    expect(metadata.freebuff_instance_id).toBe("cli:11111111-2222-4333-8444-555555555555");
    expect(metadata.freebuff_multi_session).toBe("1");
    expect(metadata.surface).toBe("cli");
    expect(String(metadata.freebuff_client_env).startsWith("v1;")).toBe(true);
    expect(String(metadata.freebuff_input_profile).startsWith("v1;")).toBe(true);
    expect(typeof metadata.repo_snapshot).toBe("string");
    expect(typeof metadata.llm_step_number).toBe("string");
    expect(metadata.client_id).toBe("ff7xdk3ftw");
    expect(typeof metadata.trace_session_id).toBe("string");
    expect(body.provider).toEqual({ data_collection: "deny" });
  });
});
