import { createAnthropicClient } from "./anthropic.ts";
import { createOpenAICompatibleClient } from "./openai-compatible.ts";
import type { ModelClient } from "./types.ts";

export type * from "./types.ts";
export { createMockClient } from "./mock.ts";
export type { MockClient, MockTurn } from "./mock.ts";

/**
 * Build a model client from environment variables, so switching vendors is configuration, not code.
 *
 *   QA_MODEL_PROVIDER   anthropic | openai          (default: anthropic)
 *   QA_MODEL            the model name your provider expects (required)
 *   QA_MODEL_API_KEY    API key for the provider (optional for local runtimes)
 *   QA_MODEL_BASE_URL   override the endpoint, e.g. a local OpenAI-compatible server
 */
export function createModelFromEnv(env: Record<string, string | undefined> = process.env): ModelClient {
  const provider = (env.QA_MODEL_PROVIDER ?? "anthropic").toLowerCase();
  const model = env.QA_MODEL;
  // An empty variable means "not set": CI systems often pass unset values as empty strings.
  const baseUrl = env.QA_MODEL_BASE_URL || undefined;
  if (!model) throw new Error("Set QA_MODEL to the model name you want to use (see .env.example).");

  switch (provider) {
    case "anthropic": {
      const apiKey = env.QA_MODEL_API_KEY;
      if (!apiKey) throw new Error("Set QA_MODEL_API_KEY for the anthropic provider.");
      return createAnthropicClient({ apiKey, model, baseUrl });
    }
    case "openai":
      return createOpenAICompatibleClient({
        apiKey: env.QA_MODEL_API_KEY || undefined,
        model,
        baseUrl,
        provider: baseUrl ? "openai-compatible" : "openai",
      });
    default:
      throw new Error(`Unknown QA_MODEL_PROVIDER "${provider}". Use "anthropic" or "openai".`);
  }
}
