// A small, vendor-neutral vocabulary for talking to language models.
// Agents only ever see these types; adapters translate them to each provider's API.

/** A JSON Schema object describing a tool's input or an agent's output. */
export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Opaque data the provider attached to this call and expects back, unchanged, in the next request.
   * Gemini 3 uses it for "thought signatures". The loop never reads it; adapters copy it through.
   */
  providerData?: Record<string, unknown>;
}

export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; text?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export interface CompletionRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionResponse {
  text?: string;
  toolCalls: ToolCall[];
  usage: Usage;
  /** True when the model stopped because it hit the output token limit: the last tool call may be incomplete. */
  truncated?: boolean;
}

/** Room for a model to think and write a structured result. Long results need more than you expect. */
export const DEFAULT_MAX_TOKENS = 8192;

/** The only thing an agent needs from a model. */
export interface ModelClient {
  readonly provider: string;
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}
