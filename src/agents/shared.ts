import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent } from "../agent/runAgent.ts";
import { createMockClient, createModelFromEnv, type MockTurn, type ModelClient } from "../llm/index.ts";

// Small helpers every QA Crew agent uses.

/** The configured model, or a scripted one when QA_MODEL_PROVIDER=mock. */
export function modelOrMock(script: () => MockTurn[], env = process.env): ModelClient {
  return (env.QA_MODEL_PROVIDER ?? "").toLowerCase() === "mock" ? createMockClient(script()) : createModelFromEnv(env);
}

/** Print the agent loop as it runs, so you can watch it think and act. */
export function printEvents(prefix = ""): (event: AgentEvent) => void {
  return (e) => {
    const tag = `${prefix}[step ${e.step}]`;
    if (e.type === "model") {
      if (e.text) console.log(`${tag} ${e.text}`);
      for (const call of e.toolCalls) {
        const input = JSON.stringify(call.input);
        console.log(`${tag} -> ${call.name}(${input.length > 80 ? input.slice(0, 77) + "..." : input})`);
      }
    } else if (e.type === "tool") {
      console.log(`${tag} <- ${e.name}${e.isError ? " (error)" : ""}: ${e.result.length} chars`);
    } else if (e.type === "truncated") {
      console.log(`${tag} response cut off at the ${e.maxTokens}-token output limit; asking for a shorter one`);
    } else {
      console.log(`${tag} invalid result: ${e.errors.join("; ")}`);
    }
  };
}

/** Agents write their results as files: easy to diff, review, edit and hand to the next agent. */
export async function writeArtifact(file: string, content: string | object): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
  return file;
}

export async function readArtifact<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

/** Load .env if present. */
export function loadEnv(): void {
  try {
    process.loadEnvFile?.();
  } catch {
    // No .env file: use the shell environment.
  }
}
