import { DEFAULT_MAX_TOKENS, type JsonSchema, type Message, type ModelClient, type ToolCall, type ToolSpec, type Usage } from "../llm/types.ts";
import { validate } from "./schema.ts";

/** A capability the agent can use: a spec the model sees, plus the code that runs. */
export interface Tool extends ToolSpec {
  run(input: Record<string, unknown>): Promise<unknown>;
}

export interface AgentOptions {
  model: ModelClient;
  /** Who the agent is and how it should work. */
  system: string;
  /** What to do this time. */
  task: string;
  tools?: Tool[];
  /** When set, the agent must finish by submitting a value that matches this schema. */
  output?: { schema: JsonSchema; description?: string };
  /** Hard stop: the maximum number of model calls. */
  maxSteps?: number;
  /** The most the model may write in one response. Structured results need room. */
  maxTokens?: number;
  /** Called after every step, for logging and tracing. */
  onEvent?: (event: AgentEvent) => void;
}

export type AgentEvent =
  | { type: "model"; step: number; text?: string; toolCalls: ToolCall[] }
  | { type: "tool"; step: number; name: string; input: Record<string, unknown>; result: string; isError: boolean }
  | { type: "invalid_output"; step: number; errors: string[] }
  | { type: "truncated"; step: number; maxTokens: number };

export interface AgentResult<T> {
  status: "done" | "max_steps";
  output?: T;
  text?: string;
  steps: number;
  usage: Usage;
  transcript: Message[];
}

export const SUBMIT_TOOL = "submit_result";

function stringify(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

export async function runAgent<T = unknown>(options: AgentOptions): Promise<AgentResult<T>> {
  const { model, system, task, tools = [], output, maxSteps = 10, maxTokens = DEFAULT_MAX_TOKENS, onEvent } = options;

  const specs: ToolSpec[] = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  if (output) {
    specs.push({
      name: SUBMIT_TOOL,
      description: output.description ?? "Submit your final result. Call this exactly once, when you are done.",
      inputSchema: output.schema,
    });
  }

  const messages: Message[] = [{ role: "user", content: task }];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };

  for (let step = 1; step <= maxSteps; step++) {
    // Guardrail: an agent that must return a result gets one last chance to do it.
    // On the final step it is told so, and submit_result is the only tool it can call.
    const lastChance = output !== undefined && step === maxSteps && maxSteps > 1;
    const response = await model.complete({
      system: lastChance
        ? `${system}\n\nThis is your last step. Call ${SUBMIT_TOOL} now with the best result you have, and say in it what you could not finish.`
        : system,
      messages,
      tools: lastChance ? specs.filter((s) => s.name === SUBMIT_TOOL) : specs,
      maxTokens,
    });
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;

    messages.push({ role: "assistant", text: response.text, toolCalls: response.toolCalls });
    onEvent?.({ type: "model", step, text: response.text, toolCalls: response.toolCalls });

    // The response hit the output limit, so the last tool call may be cut off mid-way.
    // Do not run or validate it: tell the model what happened and how to fix it.
    if (response.truncated) {
      onEvent?.({ type: "truncated", step, maxTokens });
      const notice =
        `Your response was cut off because it reached the output limit of ${maxTokens} tokens, so your tool call ` +
        `was incomplete and nothing was run. Send it again, more concisely: shorter texts, fewer items, no repetition.`;
      if (response.toolCalls.length === 0) {
        messages.push({ role: "user", content: notice });
      } else {
        for (const call of response.toolCalls) {
          messages.push({ role: "tool", toolCallId: call.id, name: call.name, isError: true, content: notice });
        }
      }
      continue;
    }

    // No tool calls: the model thinks it is done.
    if (response.toolCalls.length === 0) {
      if (!output) {
        return { status: "done", text: response.text, steps: step, usage, transcript: messages };
      }
      messages.push({
        role: "user",
        content: `You have not submitted a result yet. Call ${SUBMIT_TOOL} with your final answer.`,
      });
      continue;
    }

    for (const call of response.toolCalls) {
      if (output && call.name === SUBMIT_TOOL) {
        const errors = validate(output.schema, call.input);
        if (errors.length === 0) {
          return { status: "done", output: call.input as T, text: response.text, steps: step, usage, transcript: messages };
        }
        onEvent?.({ type: "invalid_output", step, errors });
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          isError: true,
          content: `Your result does not match the required schema. Fix these problems and call ${SUBMIT_TOOL} again:\n- ${errors.join("\n- ")}`,
        });
        continue;
      }

      const tool = tools.find((t) => t.name === call.name);
      let content: string;
      let isError = false;
      if (!tool) {
        content = `Unknown tool "${call.name}". Available tools: ${specs.map((s) => s.name).join(", ")}.`;
        isError = true;
      } else {
        try {
          content = stringify(await tool.run(call.input));
        } catch (error) {
          content = error instanceof Error ? error.message : String(error);
          isError = true;
        }
      }
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content, isError });
      onEvent?.({ type: "tool", step, name: call.name, input: call.input, result: content, isError });
    }
  }

  return { status: "max_steps", steps: maxSteps, usage, transcript: messages };
}
