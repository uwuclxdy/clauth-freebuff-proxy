/**
 * The anthropic↔openai wire conversion: anthropic
 * requests become openai chat bodies, openai answers become anthropic
 * messages, and the openai SSE stream is rebuilt as real anthropic SSE
 * events. The mappings mirror the Go proxy's anthropic.go, the working
 * reference for both directions.
 */

import { randomUUID } from "node:crypto";
import type { ObservedTokens } from "./stats.ts";

/** A request the converter refuses: the caller answers 400, never a dial. */
export class ConvertError extends Error {}

// ---- boundary readers -------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ---- anthropic request parsing ---------------------------------------------

export interface AnthropicTool {
  name: string;
  description: string | undefined;
  inputSchema: unknown;
}

export interface AnthropicThinking {
  type: "enabled" | "disabled" | "adaptive" | "auto";
  budgetTokens: number | null;
}

export type AnthropicBlock =
  | { kind: "text"; text: string }
  | { kind: "image"; mediaType: string; data: string; url: string | null }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; text: string }
  | { kind: "thinking"; text: string };

export interface ParsedAnthropicMessage {
  role: "user" | "assistant";
  blocks: AnthropicBlock[];
}

export interface ParsedAnthropicRequest {
  model: string;
  maxTokens: number | null;
  systemTexts: string[];
  messages: ParsedAnthropicMessage[];
  tools: AnthropicTool[];
  temperature: number | null;
  topP: number | null;
  stopSequences: string[] | null;
  stream: boolean;
  thinking: AnthropicThinking | null;
  outputEffort: string | null;
}

function textPartsOf(content: unknown): string[] {
  const parts: string[] = [];
  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const item of content) {
      const block = asRecord(item);
      if (block !== null && block["type"] === "text" && typeof block["text"] === "string") {
        parts.push(block["text"]);
      }
    }
  }
  return parts;
}

function parseBlock(raw: unknown): AnthropicBlock | null {
  const block = asRecord(raw);
  if (block === null) return null;
  switch (block["type"]) {
    case "text":
      return typeof block["text"] === "string" ? { kind: "text", text: block["text"] } : null;
    case "image": {
      const source = asRecord(block["source"]);
      if (source !== null && source["type"] === "base64") {
        if (typeof source["media_type"] !== "string" || typeof source["data"] !== "string") return null;
        return { kind: "image", mediaType: source["media_type"], data: source["data"], url: null };
      }
      if (source !== null && source["type"] === "url" && typeof source["url"] === "string") {
        return { kind: "image", mediaType: "", data: "", url: source["url"] };
      }
      return null;
    }
    case "tool_use":
      if (typeof block["id"] !== "string" || typeof block["name"] !== "string") return null;
      return { kind: "tool_use", id: block["id"], name: block["name"], input: block["input"] ?? {} };
    case "tool_result": {
      if (typeof block["tool_use_id"] !== "string") return null;
      return { kind: "tool_result", toolUseId: block["tool_use_id"], text: textPartsOf(block["content"]).join("\n") };
    }
    case "thinking":
      return typeof block["thinking"] === "string" ? { kind: "thinking", text: block["thinking"] } : null;
    default:
      return null;
  }
}

/** Parse the inbound anthropic-shaped body into the converter's typed input. */
export function parseAnthropicRequest(body: unknown): ParsedAnthropicRequest {
  const root = asRecord(body);
  if (root === null) throw new ConvertError("request body must be a JSON object");
  const model = asString(root["model"]);
  if (model === null || model === "") throw new ConvertError("model is required");
  const rawMessages = asArray(root["messages"]);
  if (rawMessages === null) throw new ConvertError("messages must be an array");
  const messages: ParsedAnthropicMessage[] = [];
  for (const raw of rawMessages) {
    const message = asRecord(raw);
    if (message === null) throw new ConvertError("each message must be an object");
    const role = asString(message["role"]);
    if (role !== "user" && role !== "assistant") throw new ConvertError(`unsupported message role ${JSON.stringify(role)}`);
    const rawContent = message["content"];
    const blocks: AnthropicBlock[] = [];
    if (typeof rawContent === "string") {
      blocks.push({ kind: "text", text: rawContent });
    } else if (Array.isArray(rawContent)) {
      for (const item of rawContent) {
        const block = parseBlock(item);
        if (block !== null) blocks.push(block);
      }
    } else {
      throw new ConvertError("message content must be a string or a block array");
    }
    messages.push({ role, blocks });
  }
  const tools: AnthropicTool[] = [];
  const rawTools = asArray(root["tools"]);
  if (rawTools !== null) {
    for (const raw of rawTools) {
      const tool = asRecord(raw);
      if (tool === null || typeof tool["name"] !== "string") throw new ConvertError("each tool needs a name");
      if (tool["input_schema"] === undefined || tool["input_schema"] === null) {
        throw new ConvertError(`tool ${JSON.stringify(tool["name"])} needs input_schema`);
      }
      tools.push({
        name: tool["name"],
        description: asString(tool["description"]) ?? undefined,
        inputSchema: tool["input_schema"],
      });
    }
  }
  const rawSystem = root["system"];
  const systemTexts = textPartsOf(rawSystem);
  const rawThinking = asRecord(root["thinking"]);
  const thinkingType = rawThinking === null ? null : asString(rawThinking["type"]);
  const thinking: AnthropicThinking | null =
    thinkingType === "enabled" || thinkingType === "disabled" || thinkingType === "adaptive" || thinkingType === "auto"
      ? { type: thinkingType, budgetTokens: asNumber(rawThinking?.["budget_tokens"]) }
      : null;
  const rawStop = asArray(root["stop_sequences"]);
  const stopSequences =
    rawStop === null ? null : rawStop.every((s) => typeof s === "string") ? (rawStop as string[]) : null;
  const outputConfig = asRecord(root["output_config"]);
  return {
    model,
    maxTokens: asNumber(root["max_tokens"]),
    systemTexts,
    messages,
    tools,
    temperature: asNumber(root["temperature"]),
    topP: asNumber(root["top_p"]),
    stopSequences,
    stream: root["stream"] === true,
    thinking,
    outputEffort: outputConfig === null ? null : asString(outputConfig["effort"]),
  };
}

// ---- anthropic → openai -----------------------------------------------------

/** The Go proxy's budget→effort thresholds, verbatim. */
function budgetToReasoningEffort(budget: number): string {
  if (budget <= 0) return "none";
  if (budget <= 512) return "minimal";
  if (budget <= 1024) return "low";
  if (budget <= 8192) return "medium";
  if (budget <= 24576) return "high";
  return "xhigh";
}

function reasoningEffortFor(request: ParsedAnthropicRequest): string | null {
  const thinking = request.thinking;
  if (thinking === null) return null;
  switch (thinking.type) {
    case "disabled":
      return "none";
    case "enabled":
      return thinking.budgetTokens === null ? "auto" : budgetToReasoningEffort(thinking.budgetTokens);
    case "adaptive":
    case "auto": {
      const effort = request.outputEffort === null ? "auto" : request.outputEffort.toLowerCase();
      return effort === "low" || effort === "medium" || effort === "high" ? effort : "auto";
    }
  }
}

type TextImagePart = { kind: "text"; text: string } | { kind: "image_url"; imageUrl: string };

function contentValue(parts: TextImagePart[]): string | Array<Record<string, unknown>> {
  const textOnly = parts.every((part): part is Extract<TextImagePart, { kind: "text" }> => part.kind === "text");
  if (textOnly) {
    return parts.map((part) => part.text).join("\n");
  }
  return parts.map((part) =>
    part.kind === "text" ? { type: "text", text: part.text } : { type: "image_url", image_url: { url: part.imageUrl } },
  );
}

/**
 * The openai chat body for a parsed request. The caller adds the freebuff
 * extension fields (`codebuff_metadata`, `provider`, the `stop` default) so a
 * request that fails before a dial never reaches this far.
 */
export function toOpenAiBody(request: ParsedAnthropicRequest): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  if (request.systemTexts.length > 0) {
    messages.push({ role: "system", content: request.systemTexts.join("\n") });
  }
  for (const message of request.messages) {
    if (message.role === "user") {
      const parts: TextImagePart[] = [];
      for (const block of message.blocks) {
        if (block.kind === "tool_result") {
          messages.push({ role: "tool", tool_call_id: block.toolUseId, content: block.text });
        } else if (block.kind === "text") {
          parts.push({ kind: "text", text: block.text });
        } else if (block.kind === "image") {
          const url = block.url ?? `data:${block.mediaType};base64,${block.data}`;
          parts.push({ kind: "image_url", imageUrl: url });
        }
      }
      if (parts.length > 0) {
        messages.push({ role: "user", content: contentValue(parts) });
      }
    } else {
      const textParts = message.blocks.filter((block): block is Extract<AnthropicBlock, { kind: "text" }> => block.kind === "text");
      const reasoning = message.blocks
        .filter((block): block is Extract<AnthropicBlock, { kind: "thinking" }> => block.kind === "thinking")
        .map((block) => block.text);
      const toolCalls = message.blocks
        .filter((block): block is Extract<AnthropicBlock, { kind: "tool_use" }> => block.kind === "tool_use")
        .map((block) => ({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        }));
      const text = textParts.map((block) => block.text).join("\n");
      const assistant: Record<string, unknown> = { role: "assistant" };
      if (text !== "" || toolCalls.length === 0) assistant["content"] = text;
      if (reasoning.length > 0) assistant["reasoning_content"] = reasoning.join("\n\n");
      if (toolCalls.length > 0) assistant["tool_calls"] = toolCalls;
      messages.push(assistant);
    }
  }
  const body: Record<string, unknown> = { model: request.model, messages, stream: request.stream };
  if (request.maxTokens !== null) body["max_tokens"] = request.maxTokens;
  if (request.temperature !== null) body["temperature"] = request.temperature;
  if (request.topP !== null) body["top_p"] = request.topP;
  if (request.stopSequences !== null && request.stopSequences.length > 0) body["stop"] = request.stopSequences;
  if (request.tools.length > 0) {
    body["tools"] = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        parameters: tool.inputSchema,
      },
    }));
  }
  const effort = reasoningEffortFor(request);
  if (effort !== null) body["reasoning_effort"] = effort;
  return body;
}

// ---- openai → anthropic -----------------------------------------------------

function extractUsage(usage: Record<string, unknown> | null): ObservedTokens {
  if (usage === null) return {};
  const promptTokens = asNumber(usage["prompt_tokens"]) ?? 0;
  const completionTokens = asNumber(usage["completion_tokens"]) ?? 0;
  const details = asRecord(usage["prompt_tokens_details"]);
  const cached = asNumber(details?.["cached_tokens"]) ?? 0;
  const observed: ObservedTokens = { input: promptTokens, output: completionTokens };
  if (cached > 0) {
    observed.cache_read = cached;
    observed.input = promptTokens >= cached ? promptTokens - cached : promptTokens;
  }
  return observed;
}

/** The usage an openai chat answer carried, or an empty record. */
export function openAiUsageOf(response: unknown): ObservedTokens {
  const root = asRecord(response);
  if (root === null) return {};
  return extractUsage(asRecord(root["usage"]));
}

function mapFinishReason(reason: string): string {
  const normalized = reason.trim().toLowerCase();
  if (normalized === "tool_calls" || normalized === "function_call") return "tool_use";
  if (normalized === "length") return "max_tokens";
  return "end_turn";
}

function sanitizeToolId(id: string): string {
  const trimmed = id.trim();
  if (trimmed === "") return `toolu_${mintSessionId()}`;
  const filtered = Array.from(trimmed)
    .filter((ch) => /[a-zA-Z0-9_-]/.test(ch))
    .join("");
  return filtered === "" ? `toolu_${mintSessionId()}` : filtered;
}

export function mintSessionId(): string {  let out = "";
  while (out.length < 13) {
    out += Math.floor(Math.random() * 36).toString(36);
  }
  return out.slice(0, 13);
}

function reasoningTexts(raw: unknown): string[] {
  if (typeof raw === "string") return raw === "" ? [] : [raw];
  if (!Array.isArray(raw)) return [];
  const texts: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      texts.push(item);
    } else {
      const record = asRecord(item);
      const text = record === null ? null : asString(record["text"]);
      if (text !== null && text !== "") texts.push(text);
    }
  }
  return texts;
}

function openAiResponseTexts(content: unknown): string[] {
  if (typeof content === "string") {
    return content.trim() === "" ? [] : [content];
  }
  const texts: string[] = [];
  const items = asArray(content);
  if (items !== null) {
    for (const item of items) {
      const part = asRecord(item);
      const text = part === null ? null : asString(part["text"]);
      if (part !== null && part["type"] === "text" && text !== null && text.trim() !== "") {
        texts.push(text);
      }
    }
  }
  return texts;
}

/** The openai chat-completions answer as an anthropic message. */
export function toAnthropicMessage(response: unknown, requestedModel: string): Record<string, unknown> {
  const root = asRecord(response);
  const choices = root === null ? null : asArray(root["choices"]);
  const choice = choices !== null && choices.length > 0 ? asRecord(choices[0]) : null;
  const message = choice === null ? null : asRecord(choice["message"]);
  const content: Array<Record<string, unknown>> = [];
  let sawToolCall = false;
  if (message !== null) {
    for (const text of reasoningTexts(message["reasoning_content"])) {
      content.push({ type: "thinking", thinking: text });
    }
    for (const text of openAiResponseTexts(message["content"])) {
      content.push({ type: "text", text });
    }
    const toolCalls = asArray(message["tool_calls"]) ?? [];
    for (const raw of toolCalls) {
      const call = asRecord(raw);
      if (call === null) continue;
      const fn = asRecord(call["function"]);
      if (fn === null) continue;
      sawToolCall = true;
      content.push({
        type: "tool_use",
        id: sanitizeToolId(asString(call["id"]) ?? ""),
        name: asString(fn["name"]) ?? "",
        input: parseJsonObject(asString(fn["arguments"]) ?? ""),
      });
    }
  }
  const finishReason = choice === null ? "" : asString(choice["finish_reason"]) ?? "";
  const stopReason =
    mapFinishReason(finishReason) === "end_turn" && sawToolCall ? "tool_use" : mapFinishReason(finishReason);
  const usage = root === null ? null : asRecord(root["usage"]);
  const observed = extractUsage(usage);
  const anthropicUsage: Record<string, unknown> = { input_tokens: observed.input ?? 0, output_tokens: observed.output ?? 0 };
  if (observed.cache_read !== undefined && observed.cache_read > 0) {
    anthropicUsage["cache_read_input_tokens"] = observed.cache_read;
  }
  const upstreamModel = root === null ? null : asString(root["model"]);
  return {
    id: root === null || asString(root["id"]) === null ? `msg_${mintSessionId()}` : asString(root["id"]),
    type: "message",
    role: "assistant",
    model: upstreamModel !== null && upstreamModel !== "" ? upstreamModel : requestedModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: anthropicUsage,
  };
}

function parseJsonObject(raw: string): unknown {
  if (raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

/**
 * The local count_tokens answer: every text part the request carries (system
 * included), joined with "\n", at ceil(chars / 4) — the approximation every
 * freebuff implementation serves locally, with no upstream call.
 */
export function countAnthropicTokens(body: unknown): number {
  const root = asRecord(body);
  if (root === null) throw new ConvertError("request body must be a JSON object");
  if (!Array.isArray(root["messages"])) throw new ConvertError("messages must be an array");
  const parts: string[] = [...textPartsOf(root["system"])];
  for (const raw of root["messages"] as unknown[]) {
    const message = asRecord(raw);
    if (message === null) throw new ConvertError("each message must be an object");
    const content = message["content"];
    parts.push(...textPartsOf(content));
    if (Array.isArray(content)) {
      for (const item of content) {
        const block = asRecord(item);
        if (block !== null && block["type"] === "tool_result") parts.push(...textPartsOf(block["content"]));
      }
    }
  }
  return Math.ceil(parts.join("\n").length / 4);
}

// ---- openai SSE → anthropic SSE ---------------------------------------------

interface OpenAiDelta {
  content: string;
  reasoning: unknown;
  toolCalls: unknown[];
}

interface ToolBlockState {
  id: string;
  name: string;
  started: boolean;
  arguments: string;
  blockIndex: number;
}

interface StreamState {
  messageId: string;
  model: string;
  messageStarted: boolean;
  thinkingStarted: boolean;
  thinkingBlockIndex: number;
  textStarted: boolean;
  textBlockIndex: number;
  nextBlockIndex: number;
  toolBlocks: Map<number, ToolBlockState>;
  sawToolCall: boolean;
  finishReason: string;
  lastUsage: Record<string, unknown> | null;
  messageDeltaSent: boolean;
  messageStopSent: boolean;
  contentBlocksStopped: boolean;
}

const SSE_FRAME_SEPARATOR = "\n\n";

export type SseEmitter = (name: string, payload: unknown) => void;

function reserveBlockIndex(state: StreamState, slot: "thinking" | "text"): number {
  const index = state.nextBlockIndex;
  state.nextBlockIndex += 1;
  if (slot === "thinking") state.thinkingBlockIndex = index;
  else state.textBlockIndex = index;
  return index;
}

function stopThinkingBlock(state: StreamState, emit: SseEmitter): void {
  if (!state.thinkingStarted) return;
  emit("content_block_stop", { type: "content_block_stop", index: state.thinkingBlockIndex });
  state.thinkingStarted = false;
}

function stopTextBlock(state: StreamState, emit: SseEmitter): void {
  if (!state.textStarted) return;
  emit("content_block_stop", { type: "content_block_stop", index: state.textBlockIndex });
  state.textStarted = false;
}

/** Close every open content block; emit each tool call's accumulated arguments. */
function finalContentEvents(state: StreamState, emit: SseEmitter): void {
  if (state.contentBlocksStopped) return;
  stopThinkingBlock(state, emit);
  stopTextBlock(state, emit);
  const indexes = Array.from(state.toolBlocks.keys()).sort((a, b) => a - b);
  for (const index of indexes) {
    const block = state.toolBlocks.get(index);
    if (block === undefined || !block.started) continue;
    const partialJson = block.arguments.trim();
    if (partialJson !== "") {
      emit("content_block_delta", {
        type: "content_block_delta",
        index: block.blockIndex,
        delta: { type: "input_json_delta", partial_json: partialJson },
      });
    }
    emit("content_block_stop", { type: "content_block_stop", index: block.blockIndex });
  }
  state.contentBlocksStopped = true;
}

function messageDeltaAndStop(state: StreamState, emit: SseEmitter, usage: Record<string, unknown> | null): void {
  if (!state.messageStarted) {
    state.messageId = `msg_${mintSessionId()}`;
    emit("message_start", {
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: "assistant",
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    state.messageStarted = true;
  }
  if (!state.messageDeltaSent) {
    const observed = extractUsage(usage);
    const deltaUsage: Record<string, unknown> = {
      input_tokens: observed.input ?? 0,
      output_tokens: observed.output ?? 0,
    };
    if (observed.cache_read !== undefined && observed.cache_read > 0) {
      deltaUsage["cache_read_input_tokens"] = observed.cache_read;
    }
    const effective = state.sawToolCall ? "tool_calls" : state.finishReason;
    emit("message_delta", {
      type: "message_delta",
      delta: { stop_reason: mapFinishReason(effective), stop_sequence: null },
      usage: deltaUsage,
    });
    state.messageDeltaSent = true;
  }
  if (!state.messageStopSent) {
    emit("message_stop", { type: "message_stop" });
    state.messageStopSent = true;
  }
}

function handleMessageChunk(chunk: unknown, requestedModel: string, state: StreamState, emit: SseEmitter): void {
  const root = asRecord(chunk);
  if (root === null) return;
  const id = asString(root["id"]);
  if (state.messageId === "") state.messageId = id ?? "";
  if (state.messageId === "") state.messageId = `msg_${mintSessionId()}`;
  const model = asString(root["model"]);
  if (model !== null && model !== "") state.model = model;
  else if (state.model === "") state.model = requestedModel;

  if (!state.messageStarted) {
    emit("message_start", {
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: "assistant",
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    state.messageStarted = true;
  }

  const choices = asArray(root["choices"]);
  const choice = choices !== null && choices.length > 0 ? asRecord(choices[0]) : null;
  if (choice === null) {
    // a usage-only frame (empty choices) still records usage for the close-time delta
    handleChunkUsage(root, state);
    return;
  }
  const deltaRecord = asRecord(choice["delta"]);
  const delta: OpenAiDelta = {
    content: deltaRecord === null ? "" : asString(deltaRecord["content"]) ?? "",
    reasoning: deltaRecord === null ? null : deltaRecord["reasoning_content"],
  toolCalls: (deltaRecord === null ? null : asArray(deltaRecord["tool_calls"])) ?? [],
  };

  for (const text of reasoningTexts(delta.reasoning)) {
    stopTextBlock(state, emit);
    if (!state.thinkingStarted) {
      emit("content_block_start", {
        type: "content_block_start",
        index: reserveBlockIndex(state, "thinking"),
        content_block: { type: "thinking", thinking: "" },
      });
      state.thinkingStarted = true;
    }
    emit("content_block_delta", {
      type: "content_block_delta",
      index: state.thinkingBlockIndex,
      delta: { type: "thinking_delta", thinking: text },
    });
  }

  if (delta.content !== "") {
    stopThinkingBlock(state, emit);
    if (!state.textStarted) {
      emit("content_block_start", {
        type: "content_block_start",
        index: reserveBlockIndex(state, "text"),
        content_block: { type: "text", text: "" },
      });
      state.textStarted = true;
    }
    emit("content_block_delta", {
      type: "content_block_delta",
      index: state.textBlockIndex,
      delta: { type: "text_delta", text: delta.content },
    });
  }

  for (const raw of delta.toolCalls) {
    const call = asRecord(raw);
    if (call === null) continue;
    state.sawToolCall = true;
    stopThinkingBlock(state, emit);
    stopTextBlock(state, emit);
    const upstreamIndex = asNumber(call["index"]) ?? 0;
    let block = state.toolBlocks.get(upstreamIndex);
    if (block === undefined) {
      block = { id: "", name: "", started: false, arguments: "", blockIndex: -1 };
      state.toolBlocks.set(upstreamIndex, block);
    }
    const fn = asRecord(call["function"]);
    const id = asString(call["id"]);
    const name = fn === null ? null : asString(fn["name"]);
    const argumentsChunk = fn === null ? null : asString(fn["arguments"]);
    if (id !== null && id.trim() !== "") block.id = id;
    if (name !== null && name.trim() !== "") block.name = name;
    if (argumentsChunk !== null && argumentsChunk !== "") block.arguments += argumentsChunk;
    if (!block.started && block.name !== "") {
      block.blockIndex = state.nextBlockIndex;
      state.nextBlockIndex += 1;
      emit("content_block_start", {
        type: "content_block_start",
        index: block.blockIndex,
        content_block: { type: "tool_use", id: sanitizeToolId(block.id), name: block.name, input: {} },
      });
      block.started = true;
    }
  }

  const finishReason = asString(choice["finish_reason"]);
  if (finishReason !== null && finishReason !== "") {
    state.finishReason = finishReason;
    finalContentEvents(state, emit);
  }

  handleChunkUsage(root, state);
}

function handleChunkUsage(root: Record<string, unknown>, state: StreamState): void {
  const usage = asRecord(root["usage"]);
  if (usage !== null) state.lastUsage = usage;
}

/**
 * Rebuild an openai SSE body as anthropic SSE events. `onUsage` feeds the
 * stats counters once with the last usage the stream carried — openai's
 * trailing usage-only chunk is the authoritative total, so an earlier
 * usage-bearing chunk never double-counts.
 */
export function convertOpenAiSse(
  upstream: ReadableStream<Uint8Array>,
  requestedModel: string,
  onUsage?: (tokens: ObservedTokens) => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const state: StreamState = {
    messageId: "",
    model: requestedModel,
    messageStarted: false,
    thinkingStarted: false,
    thinkingBlockIndex: 0,
    textStarted: false,
    textBlockIndex: 0,
    nextBlockIndex: 0,
    toolBlocks: new Map(),
    sawToolCall: false,
    finishReason: "",
    lastUsage: null,
    messageDeltaSent: false,
    messageStopSent: false,
    contentBlocksStopped: false,
  };
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit: SseEmitter = (name, payload) => {
        controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`));
      };
      const closeStream = (): void => {
        finalContentEvents(state, emit);
        messageDeltaAndStop(state, emit, state.lastUsage);
        if (state.lastUsage !== null && onUsage !== undefined) onUsage(extractUsage(state.lastUsage));
      };
      const decoder = new TextDecoder();
      let buffered = "";
      const handleFrame = (frame: string): boolean => {
        const dataLines = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trim());
        if (dataLines.length === 0) return false;
        const payload = dataLines.join("\n");
        if (payload === "[DONE]") return true;
        try {
          handleMessageChunk(JSON.parse(payload), requestedModel, state, emit);
        } catch {
          // a frame the JSON parser refuses is not a chat event; the stream continues
        }
        return false;
      };
      try {
        for await (const bytes of upstream) {
          buffered += decoder.decode(bytes, { stream: true });
          // normalized on the whole buffer: a chunk edge can land inside one \r\n pair
          buffered = buffered.replaceAll("\r\n", "\n");
          for (;;) {
            const separator = buffered.indexOf(SSE_FRAME_SEPARATOR);
            if (separator === -1) break;
            const frame = buffered.slice(0, separator);
            buffered = buffered.slice(separator + SSE_FRAME_SEPARATOR.length);
            if (handleFrame(frame)) {
              closeStream();
              controller.close();
              return;
            }
          }
        }
        buffered += decoder.decode();
        const tail = handleFrame(buffered);
        closeStream();
        void tail;
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}
