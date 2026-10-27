/**
 * The 8 upstream models (node README "Available Models" table, 2026-10-26) with
 * the shortcut aliases the node README resolves, including the legacy
 * `deepseek-v3.1-terminus` → `deepseek/deepseek-v4-pro` mapping. An unknown id
 * is not a model: `resolveModel` answers null and inference refuses it.
 */

export type ModelTier = "free" | "limited";

export interface FreebuffModel {
  /** The canonical model id a client names and the chat body carries. */
  id: string;
  /** The upstream agent the run chain STARTs. */
  agentId: string;
  tier: ModelTier;
  /** The model's API collects data for training. */
  training: boolean;
}

export const MODELS: readonly FreebuffModel[] = [
  { id: "minimax/minimax-m2.7", agentId: "base2-free", tier: "free", training: false },
  { id: "minimax/minimax-m3", agentId: "base2-free-minimax-m3", tier: "free", training: true },
  { id: "deepseek/deepseek-v4-flash", agentId: "base2-free-deepseek-flash", tier: "free", training: true },
  { id: "mimo/mimo-v2.5", agentId: "base2-free-mimo", tier: "free", training: false },
  { id: "google/gemini-3.1-flash-lite-preview", agentId: "base2-free-deepseek-flash", tier: "free", training: false },
  { id: "deepseek/deepseek-v4-pro", agentId: "base2-free-deepseek", tier: "limited", training: true },
  { id: "mimo/mimo-v2.5-pro", agentId: "base2-free-mimo-pro", tier: "limited", training: false },
  { id: "moonshotai/kimi-k2.6", agentId: "base2-free-kimi", tier: "limited", training: false },
];

export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
  "deepseek-v3.1-terminus": "deepseek/deepseek-v4-pro",
  "mimo-v2.5-pro": "mimo/mimo-v2.5-pro",
  "mimo-v2.5": "mimo/mimo-v2.5",
  "kimi-k2.6": "moonshotai/kimi-k2.6",
  "minimax-m2.7": "minimax/minimax-m2.7",
  "minimax-m3": "minimax/minimax-m3",
  "gemini-3.1-flash-lite": "google/gemini-3.1-flash-lite-preview",
};

/**
 * The client-side id `clauth proxy check` sends on its inference leg (a model
 * Claude Code itself sends), mapped onto the free, non-training default; the
 * chat body still dials the canonical id.
 */
export const CONTRACT_ALIASES: Readonly<Record<string, string>> = {
  "claude-haiku-4-5": "minimax/minimax-m2.7",
};

/** Resolve a canonical id or a shortcut alias, or null when neither. */
export function resolveModel(id: string): FreebuffModel | null {
  const direct = MODELS.find((model) => model.id === id);
  if (direct !== undefined) return direct;
  const alias = MODEL_ALIASES[id] ?? CONTRACT_ALIASES[id];
  if (alias === undefined) return null;
  return MODELS.find((model) => model.id === alias) ?? null;
}
