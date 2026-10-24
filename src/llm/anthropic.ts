import { DEFAULT_MAX_TOKENS, type CompletionRequest, type CompletionResponse, type Message, type ModelClient, type ToolCall } from "./types.ts";

// Adapter for the Anthropic Messages API (Claude models).

interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const blocks: ContentBlock[] = [];
      if (m.text) blocks.push({ type: "text", text: m.text });
      for (const call of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      }
      out.push({ role: "assistant", content: blocks });
    } else {
      // Anthropic expects tool results inside a user turn; consecutive results share one turn.
      const result: ContentBlock = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
        ...(m.isError ? { is_error: true } : {}),
      };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) {
        last.content.push(result);
      } else {
        out.push({ role: "user", content: [result] });
      }
    }
  }
  return out;
}

export function createAnthropicClient(options: AnthropicOptions): ModelClient {
  const baseUrl = options.baseUrl ?? "https://api.anthropic.com";
  return {
    provider: "anthropic",
    model: options.model,
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: options.model,
          max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: request.system,
          messages: toAnthropicMessages(request.messages),
          tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
        }),
      });
      if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as {
        content: ContentBlock[];
        stop_reason?: string;
        usage?: { input_tokens: number; output_tokens: number };
      };

      const text = data.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const toolCalls: ToolCall[] = data.content
        .filter((b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} }));

      return {
        text: text || undefined,
        toolCalls,
        usage: { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 },
        truncated: data.stop_reason === "max_tokens",
      };
    },
  };
}
