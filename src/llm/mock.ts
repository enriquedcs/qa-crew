import type { CompletionRequest, CompletionResponse, ModelClient, ToolCall } from "./types.ts";

// A scripted "model" for tests and for running examples without an API key.
// Each turn is either a fixed response or a function of the request so far.

export type MockTurn =
  | { text?: string; toolCalls?: Omit<ToolCall, "id">[] }
  | ((request: CompletionRequest) => { text?: string; toolCalls?: Omit<ToolCall, "id">[] });

export interface MockClient extends ModelClient {
  /** Every request the agent sent, for assertions in tests. */
  readonly requests: CompletionRequest[];
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
      return {
        text: resolved.text,
        toolCalls: (resolved.toolCalls ?? []).map((c) => ({ ...c, id: `call_${++callCounter}` })),
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}
