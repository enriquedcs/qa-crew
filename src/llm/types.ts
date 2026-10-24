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
}

/** The only thing an agent needs from a model. */
export interface ModelClient {
  readonly provider: string;
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}
