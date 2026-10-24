import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Tool } from "../agent/runAgent.ts";
import type { JsonSchema } from "../llm/types.ts";

// The bridge between MCP and runAgent(): connect to MCP servers, list their tools,
// and turn each one into the same Tool shape the agent loop already understands.
// The loop does not change at all.

/** How to launch one MCP server. The same shape Claude Code and Cursor use in their JSON configs. */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** Client-side limits on what an agent may use from a server. */
export interface McpToolFilter {
  /** Only expose these tool names. */
  include?: string[];
  /** Only expose tools the server marks as read-only (readOnlyHint: true). */
  readOnly?: boolean;
}

export interface McpConnection {
  name: string;
  config: McpServerConfig;
  filter?: McpToolFilter;
}

export interface McpToolbox {
  tools: Tool[];
  close(): Promise<void>;
}

type ContentBlock = { type: string; text?: string; mimeType?: string; resource?: { uri?: string; text?: string } };

/** Flatten an MCP tool result into the text the model will read. */
export function contentToText(content: ContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "resource" && block.resource?.text !== undefined) return block.resource.text;
      return `[${block.type}${block.mimeType ? ` ${block.mimeType}` : ""} omitted]`;
    })
    .join("\n");
}

export async function connectMcpServers(connections: McpConnection[]): Promise<McpToolbox> {
  const clients: Client[] = [];
  const tools: Tool[] = [];

  const close = async () => {
    await Promise.allSettled(clients.map((c) => c.close()));
  };

  try {
    for (const { name, config, filter } of connections) {
      const client = new Client({ name: "qa-crew", version: "0.3.0" });
      await client.connect(new StdioClientTransport({ ...config, stderr: "inherit" }));
      clients.push(client);

      const { tools: listed } = await client.listTools();
      for (const mcpTool of listed) {
        if (filter?.include && !filter.include.includes(mcpTool.name)) continue;
        if (filter?.readOnly && mcpTool.annotations?.readOnlyHint !== true) continue;
        if (tools.some((t) => t.name === mcpTool.name)) {
          throw new Error(`Two MCP servers expose a tool named "${mcpTool.name}" (the second is "${name}").`);
        }

        tools.push({
          name: mcpTool.name,
          description: mcpTool.description ?? mcpTool.title ?? mcpTool.name,
          inputSchema: (mcpTool.inputSchema ?? { type: "object", properties: {} }) as JsonSchema,
          run: async (input) => {
            const result = await client.callTool({ name: mcpTool.name, arguments: input });
            const text = contentToText((result.content ?? []) as ContentBlock[]);
            // runAgent() already turns thrown errors into error results the model can read.
            if (result.isError) throw new Error(text || `Tool ${mcpTool.name} failed.`);
            return text;
          },
        });
      }
    }
  } catch (error) {
    await close();
    throw error;
  }

  return { tools, close };
}

/** Replace ${VAR} and ${VAR:-default} with values from the environment, as Claude Code does in .mcp.json. */
export function expandEnv(value: string, env: Record<string, string | undefined> = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, key: string, fallback?: string) => {
    const resolved = env[key] ?? fallback;
    if (resolved === undefined) throw new Error(`Environment variable ${key} is not set (used in the MCP config).`);
    return resolved;
  });
}

/**
 * Read server definitions from a project's .mcp.json, the file Claude Code reads too.
 * One config file, many hosts: your agents and your coding assistant launch the same servers.
 */
export async function loadMcpConfig(
  file = ".mcp.json",
  env: Record<string, string | undefined> = process.env,
): Promise<Record<string, McpServerConfig>> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as { mcpServers?: Record<string, McpServerConfig> };
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(parsed.mcpServers ?? {})) {
    servers[name] = {
      command: expandEnv(server.command, env),
      args: server.args?.map((a) => expandEnv(a, env)),
      env: server.env && Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, expandEnv(v, env)])),
      cwd: server.cwd && expandEnv(server.cwd, env),
    };
  }
  return servers;
}
