// Entry point for the qa-tools MCP server, over stdio.
//
// You rarely run this by hand: an MCP host (your agent, Claude Code, Cursor,
// Copilot, Codex...) launches it as a child process. To try it yourself:
//
//   npx @modelcontextprotocol/inspector npx tsx src/tools/qa-tools/main.ts
//
// Remember: stdout is the protocol channel. Log with console.error only.

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createQaToolsServer, optionsFromEnv } from "./createServer.ts";

try {
  process.loadEnvFile?.();
} catch {
  // No .env file: use the environment the host passed in.
}

const options = optionsFromEnv();

try {
  // Build one server up front so a bad configuration fails before any client connects.
  createQaToolsServer(options);
} catch (error) {
  console.error(`qa-tools: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

serveStdio(() => createQaToolsServer(options));
console.error(
  `qa-tools MCP server on stdio — booking app ${options.bookingUrl}, writes ${options.allowWrites ? "ENABLED" : "disabled"}`,
);
