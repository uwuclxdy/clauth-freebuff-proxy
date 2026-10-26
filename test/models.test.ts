import { describe, expect, test } from "bun:test";
import { MODELS, MODEL_ALIASES, resolveModel } from "../src/models.ts";

// The table is pinned verbatim from the node README's "Available Models" table
// (2026-10-26 cache), the alias list from its "Shortcuts" section.

describe("model table", () => {
  test("ships exactly the 8 upstream models with their agent ids, tiers and training flags", () => {
    expect(MODELS).toEqual([
      { id: "minimax/minimax-m2.7", agentId: "base2-free", tier: "free", training: false },
      { id: "minimax/minimax-m3", agentId: "base2-free-minimax-m3", tier: "free", training: true },
      { id: "deepseek/deepseek-v4-flash", agentId: "base2-free-deepseek-flash", tier: "free", training: true },
      { id: "mimo/mimo-v2.5", agentId: "base2-free-mimo", tier: "free", training: false },
      { id: "google/gemini-3.1-flash-lite-preview", agentId: "base2-free-deepseek-flash", tier: "free", training: false },
      { id: "deepseek/deepseek-v4-pro", agentId: "base2-free-deepseek", tier: "limited", training: true },
      { id: "mimo/mimo-v2.5-pro", agentId: "base2-free-mimo-pro", tier: "limited", training: false },
      { id: "moonshotai/kimi-k2.6", agentId: "base2-free-kimi", tier: "limited", training: false },
    ]);
  });

  test("the shortcut aliases resolve per the README list", () => {
    expect(MODEL_ALIASES).toEqual({
      "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
      "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
      "deepseek-v3.1-terminus": "deepseek/deepseek-v4-pro",
      "mimo-v2.5-pro": "mimo/mimo-v2.5-pro",
      "mimo-v2.5": "mimo/mimo-v2.5",
      "kimi-k2.6": "moonshotai/kimi-k2.6",
      "minimax-m2.7": "minimax/minimax-m2.7",
      "minimax-m3": "minimax/minimax-m3",
      "gemini-3.1-flash-lite": "google/gemini-3.1-flash-lite-preview",
    });
    expect(resolveModel("deepseek-v3.1-terminus")?.id).toBe("deepseek/deepseek-v4-pro");
    expect(resolveModel("gemini-3.1-flash-lite")?.id).toBe("google/gemini-3.1-flash-lite-preview");
  });

  test("canonical ids resolve directly; anything else is not a model", () => {
    expect(resolveModel("minimax/minimax-m2.7")?.agentId).toBe("base2-free");
    expect(resolveModel("moonshotai/kimi-k2.6")?.tier).toBe("limited");
    expect(resolveModel("gpt-4o")).toBeNull();
    expect(resolveModel("")).toBeNull();
  });
});
