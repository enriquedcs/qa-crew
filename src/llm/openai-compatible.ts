import { describeApiError, fetchWithRetry } from "./http.ts";
import { DEFAULT_MAX_TOKENS, type CompletionRequest, type CompletionResponse, type Message, type ModelClient, type ToolCall } from "./types.ts";

// Adapter for any API that speaks the OpenAI Chat Completions format:
// OpenAI itself, and many other providers and local runtimes (for example Ollama or LM Studio)
// that expose an OpenAI-compatible endpoint. Point baseUrl at the provider you want.

interface OpenAICompatibleOptions {
  apiKey?: string;
  model: string;
  baseUrl?: string;
  provider?: string;
}

/** A tool call as the API sends it. Gemini adds extra_content.google.thought_signature. */
interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  extra_content?: Record<string, unknown>;
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

function toChatMessages(system: string, messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const toolCalls: OpenAIToolCall[] = (m.toolCalls ?? []).map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: JSON.stringify(c.input) },
        // Send back exactly what the provider attached, or Gemini 3 rejects the request.
        ...(c.providerData?.extra_content ? { extra_content: c.providerData.extra_content as Record<string, unknown> } : {}),
      }));
      out.push(
        toolCalls.length > 0
          ? { role: "assistant", content: m.text ?? null, tool_calls: toolCalls }
          : { role: "assistant", content: m.text ?? null },
      );
    } else {
      const content = m.isError ? `ERROR: ${m.content}` : m.content;
      out.push({ role: "tool", tool_call_id: m.toolCallId, content });
    }
  }
  return out;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return { _unparsed: raw };
  }
}

export function createOpenAICompatibleClient(options: OpenAICompatibleOptions): ModelClient {
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const provider = options.provider ?? "openai";
  return {
    provider,
    model: options.model,
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

      const body: Record<string, unknown> = {
        model: options.model,
        max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: toChatMessages(request.system, request.messages),
      };
      if (request.tools.length > 0) {
        body.tools = request.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        }));
      }

      const res = await fetchWithRetry(`${baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await describeApiError(provider, res));
      const data = (await res.json()) as {
        choices: {
          finish_reason?: string;
          message: {
            content: string | null;
            tool_calls?: Omit<OpenAIToolCall, "type">[];
          };
        }[];
        usage?: { prompt_tokens: number; completion_tokens: number };
      };

      const message = data.choices[0]?.message ?? { content: null };
      const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        input: parseArguments(c.function.arguments),
        ...(c.extra_content ? { providerData: { extra_content: c.extra_content } } : {}),
      }));

      return {
        text: message.content ?? undefined,
        toolCalls,
        usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
        truncated: data.choices[0]?.finish_reason === "length",
      };
    },
  };
}
