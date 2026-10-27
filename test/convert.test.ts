import { describe, expect, test } from "bun:test";
import {
  ConvertError,
  convertOpenAiSse,
  countAnthropicTokens,
  parseAnthropicRequest,
  toAnthropicMessage,
  toOpenAiBody,
} from "../src/convert.ts";

// Hand-pinned fixtures: the request mappings from the Go proxy's
// reference (anthropic.go), the effort thresholds from its
// budgetToReasoningEffort, and the SSE sequences from the Go stream state
// machine (arguments buffered, one input_json_delta at finish).

function openaiChunk(delta: unknown, finishReason: string | null, usage?: unknown): string {
  return `data: ${JSON.stringify({ id: "chatcmpl-1", model: "minimax/minimax-m2.7", choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage === undefined ? {} : { usage }) })}\n\n`;
}

function streamOf(frames: string[]): ReadableStream<Uint8Array> {
  return new Response(frames.join("")).body!;
}

async function sseEvents(stream: ReadableStream<Uint8Array>): Promise<Array<{ event: string; data: any }>> {
  const raw = await new Response(stream).text();
  return raw
    .split("\n\n")
    .filter((frame) => frame.startsWith("event:"))
    .map((frame) => {
      const lines = frame.split("\n");
      const event = lines.find((line) => line.startsWith("event:"))!.slice("event:".length).trim();
      const dataLine = lines.find((line) => line.startsWith("data:"));
      return { event, data: dataLine === undefined ? null : JSON.parse(dataLine!.slice("data:".length).trim()) };
    });
}

describe("anthropic → openai requests", () => {
  test("a text-only user message becomes one string-content message, no system invented", () => {
    const body = toOpenAiBody(parseAnthropicRequest({ model: "minimax/minimax-m2.7", messages: [{ role: "user", content: "hi" }] }));
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.model).toBe("minimax/minimax-m2.7");
    expect(body.stream).toBe(false);
  });

  test("system blocks become one system message ahead of the conversation", () => {
    const body = toOpenAiBody(
      parseAnthropicRequest({
        model: "minimax/minimax-m2.7",
        system: [{ type: "text", text: "be brief" }, { type: "text", text: "use tools" }],
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(body.messages).toEqual([{ role: "system", content: "be brief\nuse tools" }, { role: "user", content: "hi" }]);
  });

  test("tool_use rides assistant tool_calls; tool_result rides role tool; tools map to the openai form", () => {
    const body = toOpenAiBody(
      parseAnthropicRequest({
        model: "minimax/minimax-m2.7",
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } }],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "sunny" }] },
        ],
        tools: [{ name: "get_weather", description: "get weather", input_schema: { type: "object" } }],
      }),
    );
    expect(body.messages).toEqual([
      { role: "user", content: "weather?" },
      { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "sunny" },
    ]);
    expect(body.tools).toEqual([{ type: "function", function: { name: "get_weather", description: "get weather", parameters: { type: "object" } } }]);
  });

  test("stop/max_tokens/temperature/top_p/stream pass through; stop stays absent when the client sent none", () => {
    const body = toOpenAiBody(
      parseAnthropicRequest({
        model: "minimax/minimax-m2.7",
        max_tokens: 256,
        temperature: 0.5,
        top_p: 0.9,
        stream: true,
        stop_sequences: ["END"],
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(body.max_tokens).toBe(256);
    expect(body.temperature).toBe(0.5);
    expect(body.top_p).toBe(0.9);
    expect(body.stream).toBe(true);
    expect(body.stop).toEqual(["END"]);
    const plain = toOpenAiBody(parseAnthropicRequest({ model: "m", messages: [] }));
    expect("stop" in plain).toBe(false);
  });

  test("images become image_url parts (base64 as a data url, url source verbatim)", () => {
    const body = toOpenAiBody(
      parseAnthropicRequest({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "see" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
              { type: "image", source: { type: "url", url: "https://example.test/x.png" } },
            ],
          },
        ],
      }),
    );
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "see" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          { type: "image_url", image_url: { url: "https://example.test/x.png" } },
        ],
      },
    ]);
  });

  test("thinking budgets map to reasoning_effort on the Go thresholds", () => {
    const effort = (thinking: unknown): unknown => toOpenAiBody(parseAnthropicRequest({ model: "m", messages: [], thinking })).reasoning_effort;
    expect(effort({ type: "enabled", budget_tokens: 0 })).toBe("none");
    expect(effort({ type: "enabled", budget_tokens: 512 })).toBe("minimal");
    expect(effort({ type: "enabled", budget_tokens: 1024 })).toBe("low");
    expect(effort({ type: "enabled", budget_tokens: 8192 })).toBe("medium");
    expect(effort({ type: "enabled", budget_tokens: 24576 })).toBe("high");
    expect(effort({ type: "enabled", budget_tokens: 32768 })).toBe("xhigh");
    expect(effort({ type: "disabled" })).toBe("none");
    expect(effort({ type: "enabled" })).toBe("auto");
    expect(effort({ type: "auto" })).toBe("auto");
    expect("reasoning_effort" in toOpenAiBody(parseAnthropicRequest({ model: "m", messages: [] }))).toBe(false);
  });

  test("assistant thinking blocks ride reasoning_content", () => {
    const body = toOpenAiBody(
      parseAnthropicRequest({
        model: "m",
        messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "thinking", thinking: "aha" }] }],
      }),
    );
    expect(body.messages).toEqual([{ role: "assistant", content: "", reasoning_content: "hmm\n\naha" }]);
  });

  test("a tool-calling assistant carries no empty content key", () => {
    const body = toOpenAiBody(
      parseAnthropicRequest({
        model: "m",
        messages: [{ role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "f", input: {} }] }],
      }),
    );
    expect(body.messages).toEqual([
      { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
    ]);
  });

  test("tool_choice maps onto the openai forms; the parallel flag inverts", () => {
    const auto = toOpenAiBody(parseAnthropicRequest({ model: "m", messages: [], tool_choice: { type: "auto" } }));
    expect(auto.tool_choice).toBe("auto");
    const any = toOpenAiBody(parseAnthropicRequest({ model: "m", messages: [], tool_choice: { type: "any" } }));
    expect(any.tool_choice).toBe("required");
    const tool = toOpenAiBody(parseAnthropicRequest({ model: "m", messages: [], tool_choice: { type: "tool", name: "get_weather" } }));
    expect(tool.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
    const noParallel = toOpenAiBody(
      parseAnthropicRequest({ model: "m", messages: [], tool_choice: { type: "auto", disable_parallel_tool_use: true } }),
    );
    expect(noParallel.tool_choice).toBe("auto");
    expect(noParallel.parallel_tool_calls).toBe(false);
    const plain = toOpenAiBody(parseAnthropicRequest({ model: "m", messages: [] }));
    expect("tool_choice" in plain).toBe(false);
    expect("parallel_tool_calls" in plain).toBe(false);
  });

  test("a malformed tool_choice names the defect", () => {
    expect(() => parseAnthropicRequest({ model: "m", messages: [], tool_choice: "auto" })).toThrow(ConvertError);
    expect(() => parseAnthropicRequest({ model: "m", messages: [], tool_choice: { type: "sometimes" } })).toThrow(ConvertError);
    expect(() => parseAnthropicRequest({ model: "m", messages: [], tool_choice: { type: "tool" } })).toThrow(ConvertError);
  });

  test("a malformed request names the defect", () => {
    expect(() => parseAnthropicRequest({ messages: [] })).toThrow(ConvertError);
    expect(() => parseAnthropicRequest({ model: "m", messages: "no" })).toThrow(ConvertError);
    expect(() => parseAnthropicRequest({ model: "m", messages: [{ role: "system", content: "x" }] })).toThrow(ConvertError);
    expect(() => parseAnthropicRequest({ model: "m", messages: [], tools: [{ input_schema: {} }] })).toThrow(ConvertError);
  });
});

describe("count_tokens", () => {
  test("ceil of the joined text chars over 4, system included", () => {
    expect(countAnthropicTokens({ messages: [{ role: "user", content: "hello world" }] })).toBe(3);
    expect(countAnthropicTokens({ system: "abc", messages: [{ role: "user", content: "hello world" }] })).toBe(4);
    expect(countAnthropicTokens({ messages: [{ role: "user", content: [{ type: "text", text: "abcd" }] }] })).toBe(1);
    expect(countAnthropicTokens({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "12345" }] }] })).toBe(2);
  });

  test("a malformed body is a ConvertError, not a wrong count", () => {
    expect(() => countAnthropicTokens({})).toThrow(ConvertError);
    expect(() => countAnthropicTokens(null)).toThrow(ConvertError);
  });
});

describe("openai → anthropic responses", () => {
  test("the tool-call answer converts to an exact anthropic message", () => {
    const message = toAnthropicMessage(
      {
        id: "chatcmpl-1",
        model: "minimax/minimax-m2.7",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      "minimax/minimax-m2.7",
    );
    expect(message).toEqual({
      id: "chatcmpl-1",
      type: "message",
      role: "assistant",
      model: "minimax/minimax-m2.7",
      content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  });

  test("cached_tokens split into cache_read and reduced input", () => {
    const message = toAnthropicMessage(
      {
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 8 } },
      },
      "requested-model",
    );
    expect(message.usage).toEqual({ input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 8 });
    expect(message.content).toEqual([{ type: "text", text: "hi" }]);
    expect(message.stop_reason).toBe("end_turn");
  });

  test("finish_reason length maps to max_tokens; a missing upstream model falls back to the request", () => {
    const message = toAnthropicMessage(
      { choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "length" }] }, "requested-model",
    );
    expect(message.stop_reason).toBe("max_tokens");
    expect(message.model).toBe("requested-model");
  });

  test("reasoning_content becomes a thinking block ahead of the text", () => {
    const message = toAnthropicMessage(
      {
        choices: [{ index: 0, message: { role: "assistant", content: "answer", reasoning_content: "pondering" }, finish_reason: "stop" }],
      },
      "m",
    );
    expect(message.content).toEqual([
      { type: "thinking", thinking: "pondering" },
      { type: "text", text: "answer" },
    ]);
  });

  test("arguments that fail to parse read as an empty tool input", () => {
    const message = toAnthropicMessage(
      {
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "not json" } }] },
            finish_reason: "tool_calls",
          },
        ],
      },
      "m",
    );
    expect(message.content).toEqual([{ type: "tool_use", id: "call_1", name: "f", input: {} }]);
  });
});

describe("openai SSE → anthropic SSE", () => {
  test("a text stream emits the exact event sequence with the usage on message_delta", async () => {
    const events = await sseEvents(
      convertOpenAiSse(
        streamOf([
          openaiChunk({ role: "assistant" }, null),
          openaiChunk({ content: "Hello" }, null),
          openaiChunk({ content: " world" }, null),
          openaiChunk({}, "stop", { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 }),
          "data: [DONE]\n\n",
        ]),
        "minimax/minimax-m2.7",
      ),
    );
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[0]!.data.message).toEqual({
      id: "chatcmpl-1",
      type: "message",
      role: "assistant",
      model: "minimax/minimax-m2.7",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(events[1]!.data).toEqual({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    expect(events[2]!.data).toEqual({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } });
    expect(events[3]!.data).toEqual({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } });
    expect(events[4]!.data).toEqual({ type: "content_block_stop", index: 0 });
    expect(events[5]!.data).toEqual({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 7, output_tokens: 2 },
    });
    expect(events[6]!.data).toEqual({ type: "message_stop" });
  });

  test("tool-call argument deltas buffer into one input_json_delta and stop_reason tool_use", async () => {
    const events = await sseEvents(
      convertOpenAiSse(
        streamOf([
          openaiChunk({ tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "get_weather", arguments: '{"city":' } }] }, null),
          openaiChunk({ tool_calls: [{ index: 0, function: { arguments: '"SF"}' } }] }, null),
          openaiChunk({}, "tool_calls", { prompt_tokens: 4, completion_tokens: 1 }),
          "data: [DONE]\n\n",
        ]),
        "m",
      ),
    );
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[1]!.data).toEqual({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "call_9", name: "get_weather", input: {} },
    });
    expect(events[2]!.data.delta).toEqual({ type: "input_json_delta", partial_json: '{"city":"SF"}' });
    expect(events[4]!.data.delta.stop_reason).toBe("tool_use");
  });

  test("reasoning_content streams as a thinking block that closes before the text", async () => {
    const events = await sseEvents(
      convertOpenAiSse(
        streamOf([
          openaiChunk({ reasoning_content: "thinking" }, null),
          openaiChunk({ content: "answer" }, null),
          openaiChunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1 }),
          "data: [DONE]\n\n",
        ]),
        "m",
      ),
    );
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[1]!.data.content_block).toEqual({ type: "thinking", thinking: "" });
    expect(events[2]!.data.delta).toEqual({ type: "thinking_delta", thinking: "thinking" });
    expect(events[5]!.data.delta).toEqual({ type: "text_delta", text: "answer" });
  });

  test("a stream cut without [DONE] or finish_reason still ends with a delta and a stop", async () => {
    const events = await sseEvents(
      convertOpenAiSse(streamOf([openaiChunk({ content: "partial" }, null)]), "m"),
    );
    expect(events.at(-2)!.event).toBe("message_delta");
    expect(events.at(-2)!.data.delta.stop_reason).toBe("end_turn");
    expect(events.at(-1)!.event).toBe("message_stop");
  });

  test("usage on a pre-finish chunk feeds the stats hook without moving message_delta early", async () => {
    const seen: Array<Record<string, number | undefined>> = [];
    const events = await sseEvents(
      convertOpenAiSse(
        streamOf([
          openaiChunk({ content: "a" }, null, { prompt_tokens: 5, completion_tokens: 0 }),
          openaiChunk({}, "stop", { prompt_tokens: 6, completion_tokens: 1 }),
          "data: [DONE]\n\n",
        ]),
        "m",
        (tokens) => seen.push({ ...tokens }),
      ),
    );
    expect(seen).toEqual([{ input: 6, output: 1 }]);
    expect(events.filter((e) => e.event === "message_delta").length).toBe(1);
    expect(events.filter((e) => e.event === "message_delta")[0]!.data.usage).toEqual({ input_tokens: 6, output_tokens: 1 });
  });

  test("a usage-only trailing chunk (empty choices) feeds the hook without moving message_delta", async () => {
    const seen: Array<Record<string, number | undefined>> = [];
    const events = await sseEvents(
      convertOpenAiSse(
        streamOf([
          openaiChunk({ content: "a" }, "stop", { prompt_tokens: 6, completion_tokens: 1 }),
          `data: ${JSON.stringify({ id: "chatcmpl-1", model: "minimax/minimax-m2.7", choices: [], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\n`,
          "data: [DONE]\n\n",
        ]),
        "m",
        (tokens) => seen.push({ ...tokens }),
      ),
    );
    expect(seen).toEqual([{ input: 9, output: 1 }]);
    expect(events.filter((e) => e.event === "message_delta").length).toBe(1);
    expect(events.filter((e) => e.event === "message_delta")[0]!.data.usage).toEqual({ input_tokens: 9, output_tokens: 1 });
  });

  test("usage on an early chunk survives a usage-less finish in message_delta, fed once", async () => {
    const seen: Array<Record<string, number | undefined>> = [];
    const events = await sseEvents(
      convertOpenAiSse(
        streamOf([
          openaiChunk({ content: "a" }, null, { prompt_tokens: 5, completion_tokens: 0 }),
          openaiChunk({ content: "b" }, "stop"),
          "data: [DONE]\n\n",
        ]),
        "m",
        (tokens) => seen.push({ ...tokens }),
      ),
    );
    expect(seen).toEqual([{ input: 5, output: 0 }]);
    expect(events.filter((e) => e.event === "message_delta").length).toBe(1);
    expect(events.filter((e) => e.event === "message_delta")[0]!.data.usage).toEqual({ input_tokens: 5, output_tokens: 0 });
  });

  test("a non-SSE frame is skipped, not fatal", async () => {
    const events = await sseEvents(
      convertOpenAiSse(streamOf(["data: not-json\n\n", openaiChunk({ content: "ok" }, "stop"), "data: [DONE]\n\n"]), "m"),
    );
    expect(events.filter((e) => e.event === "content_block_delta")[0]!.data.delta.text).toBe("ok");
  });
});
