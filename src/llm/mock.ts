import type { CompletionRequest, CompletionResponse, ModelClient, ToolCall } from "./types.ts";

// A scripted "model" for tests and for running examples without an API key.
// Each turn is either a fixed response or a function of the request so far.

export type MockTurn =
  | { text?: string; toolCalls?: Omit<ToolCall, "id">[]; truncated?: boolean }
  | ((request: CompletionRequest) => { text?: string; toolCalls?: Omit<ToolCall, "id">[]; truncated?: boolean });

export interface MockClient extends ModelClient {
  /** Every request the agent sent, for assertions in tests. */
  readonly requests: CompletionRequest[];
}

/** Roughly four characters per token: close enough for budgets and demos, never for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function createMockClient(turns: MockTurn[]): MockClient {
  const requests: CompletionRequest[] = [];
  let callCounter = 0;
  return {
    provider: "mock",
    model: "scripted",
    requests,
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      // Keep a snapshot so later mutations by the agent loop don't change what we recorded.
      requests.push({ ...request, messages: [...request.messages] });
      const turn = turns[requests.length - 1];
      if (!turn) throw new Error(`Mock model ran out of scripted turns at request ${requests.length}`);
      const resolved = typeof turn === "function" ? turn(request) : turn;
      // A scripted model costs nothing, but an estimate keeps budgets and summaries realistic.
      const prompt = request.system + JSON.stringify(request.messages) + JSON.stringify(request.tools);
      const answer = (resolved.text ?? "") + JSON.stringify(resolved.toolCalls ?? []);
      return {
        text: resolved.text,
        toolCalls: (resolved.toolCalls ?? []).map((c) => ({ ...c, id: `call_${++callCounter}` })),
        usage: { inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(answer) },
        ...(resolved.truncated ? { truncated: true } : {}),
      };
    },
  };
}
