// Entry point for the qa-crew MCP server, over stdio (Chapter 11).
//
// An MCP host launches it from .mcp.json: Claude Code, Cursor, VS Code with Copilot, Codex...
// To try it by hand:
//
//   npx @modelcontextprotocol/inspector npx tsx src/tools/crew/main.ts
//
// stdout is the protocol channel. The agents print progress with console.log, so in this
// process console.log is redirected to stderr, where hosts show it as server logs.

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { crewStages } from "../../crew/stages.ts";
import { createCrewServer } from "./createServer.ts";

console.log = console.error;

try {
  process.loadEnvFile?.();
} catch {
  // No .env file: use the environment the host passed in.
}

const options = {
  store: { root: process.env.QA_CREW_RUNS ?? "out/crew" },
  stages: () => crewStages({ verbose: false }),
  allowAutoGates: process.env.QA_CREW_ALLOW_AUTO_GATES === "true",
  maxTokens: Number(process.env.QA_CREW_MAX_TOKENS ?? 400_000),
  maxWaiting: Number(process.env.QA_CREW_MAX_WAITING ?? 2),
};

serveStdio(() => createCrewServer(options));
console.error(`qa-crew MCP server on stdio — runs in ${options.store.root}, auto gates ${options.allowAutoGates ? "ALLOWED" : "refused"}`);
