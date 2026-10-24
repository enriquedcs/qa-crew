import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { searchKnowledge } from "../../knowledge/search.ts";
import { loadRequirements } from "../../specs/requirements.ts";
import { buildTraceReport, findRequirementTags } from "../../specs/trace.ts";
import { assertTestEnvironment, resolveInside } from "./safety.ts";

// qa-tools: the booking app and the test suite, exposed as MCP tools.
// Any MCP host can use them: QA Crew's agents, Claude Code, Cursor, Copilot, Codex...

export interface QaToolsOptions {
  /** Where the booking app runs. Must be a test environment. */
  bookingUrl: string;
  /** Hosts besides localhost that count as test environments. */
  allowedHosts?: string[];
  /** Register the tools that change data. Off by default. */
  allowWrites?: boolean;
  /** Folder the test-reading tools may read from. */
  testsDir?: string;
  /** File that documents the API (the "Booking API" section is returned). */
  readmePath?: string;
  /** Project root that holds specs/ (Spec Kit) and odd/tasks/ (ODD feature documents). */
  projectRoot?: string;
  /** Folder of team knowledge (past bugs, notes) that search_knowledge reads. */
  knowledgeDir?: string;
}

export function optionsFromEnv(env: Record<string, string | undefined> = process.env): QaToolsOptions {
  return {
    bookingUrl: env.BOOKING_URL ?? "http://localhost:3000",
    allowedHosts: (env.QA_TOOLS_ALLOWED_HOSTS ?? "").split(","),
    allowWrites: env.QA_TOOLS_ALLOW_WRITES === "true",
    testsDir: env.QA_TOOLS_TESTS_DIR ?? "tests",
    readmePath: env.QA_TOOLS_README ?? "README.md",
    projectRoot: env.QA_TOOLS_PROJECT_ROOT ?? ".",
    knowledgeDir: env.QA_TOOLS_KNOWLEDGE_DIR ?? "knowledge",
  };
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function createQaToolsServer(options: QaToolsOptions): McpServer {
  // Fail fast: a server pointed at the wrong environment should not start at all.
  const base = assertTestEnvironment(options.bookingUrl, options.allowedHosts);
  const testsDir = path.resolve(options.testsDir ?? "tests");
  const readmePath = path.resolve(options.readmePath ?? "README.md");
  const projectRoot = path.resolve(options.projectRoot ?? ".");
  const knowledgeDir = path.resolve(options.knowledgeDir ?? "knowledge");

  async function api(pathname: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
    const res = await fetch(new URL(pathname, base), {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: keep the raw text.
    }
    return { status: res.status, body };
  }

  const server = new McpServer({ name: "qa-tools", version: "0.5.0" });
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

  // ---------- Read-only tools: safe to call as often as the agent likes ----------

  server.registerTool(
    "list_rooms",
    {
      title: "List rooms",
      description: "List the rooms in the booking app, with capacity (maximum guests) and price per night.",
      annotations: readOnly,
    },
    async () => {
      const { status, body } = await api("/api/rooms");
      return status === 200 ? json(body) : failure(`GET /api/rooms returned ${status}`);
    },
  );

  server.registerTool(
    "list_bookings",
    {
      title: "List bookings",
      description: "List all current bookings in the booking app.",
      annotations: readOnly,
    },
    async () => {
      const { status, body } = await api("/api/bookings");
      return status === 200 ? json(body) : failure(`GET /api/bookings returned ${status}`);
    },
  );

  server.registerTool(
    "get_booking",
    {
      title: "Get booking",
      description: "Get one booking by its id, for example b1.",
      inputSchema: z.object({ id: z.string().min(1).describe("The booking id, for example b1") }),
      annotations: readOnly,
    },
    async ({ id }) => {
      const { status, body } = await api(`/api/bookings/${encodeURIComponent(id)}`);
      if (status === 404) return failure(`No booking with id "${id}". Use list_bookings to see the existing ids.`);
      return status === 200 ? json(body) : failure(`GET /api/bookings/${id} returned ${status}`);
    },
  );

  server.registerTool(
    "get_api_reference",
    {
      title: "Get API reference",
      description: "Get the booking API's endpoints and the fields a booking needs.",
      annotations: readOnly,
    },
    async () => {
      const readme = await readFile(readmePath, "utf8");
      const start = readme.indexOf("## Booking API");
      if (start === -1) return failure("The README has no 'Booking API' section.");
      const end = readme.indexOf("\n## ", start + 1);
      return { content: [{ type: "text", text: readme.slice(start, end === -1 ? undefined : end) }] };
    },
  );

  server.registerTool(
    "list_test_files",
    {
      title: "List test files",
      description: "List the automated test files in the project, as paths relative to the tests folder.",
      annotations: readOnly,
    },
    async () => {
      const entries = await readdir(testsDir, { recursive: true, withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile() && e.name.endsWith(".ts"))
        .map((e) => path.relative(testsDir, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
        .sort();
      return json(files);
    },
  );

  server.registerTool(
    "read_test_file",
    {
      title: "Read test file",
      description: "Read one test file. Use a path returned by list_test_files, for example baseline/api.spec.ts.",
      inputSchema: z.object({ path: z.string().min(1).describe("Path relative to the tests folder") }),
      annotations: readOnly,
    },
    async ({ path: requested }) => {
      const file = resolveInside(testsDir, requested);
      try {
        return { content: [{ type: "text", text: await readFile(file, "utf8") }] };
      } catch {
        return failure(`Cannot read "${requested}". Use list_test_files to see the available files.`);
      }
    },
  );

  server.registerTool(
    "list_requirements",
    {
      title: "List requirements",
      description:
        "List the product requirements from Spec Kit specs (specs/) and ODD feature documents (odd/tasks/), " +
        "with their ids, acceptance checks and open questions. Use the ids to tag tests.",
      inputSchema: z.object({
        key: z.string().optional().describe("Only this document, for example booking-rules or max-stay-limit"),
      }),
      annotations: readOnly,
    },
    async ({ key }) => {
      const docs = await loadRequirements(projectRoot);
      const selected = key ? docs.filter((d) => d.key === key) : docs;
      if (key && selected.length === 0) {
        return failure(`No requirements document "${key}". Available: ${docs.map((d) => d.key).join(", ")}.`);
      }
      return json(selected);
    },
  );

  server.registerTool(
    "trace_requirements",
    {
      title: "Trace requirements to tests",
      description:
        "Report which requirements have tests (by tag, for example @booking-rules:FR-005), which have none, " +
        "which test tags match no requirement, and which questions are still open.",
      annotations: readOnly,
    },
    async () => {
      const docs = await loadRequirements(projectRoot);
      return json(buildTraceReport(docs, await findRequirementTags(testsDir)));
    },
  );

  server.registerTool(
    "search_knowledge",
    {
      title: "Search team knowledge",
      description:
        "Search the team's past bug reports and notes. Use specific words from the area you are analyzing, " +
        "for example 'double booking concurrent' or 'check-in today time zone'. Returns the best matching sections.",
      inputSchema: z.object({
        query: z.string().min(2).describe("Words to look for"),
        limit: z.number().int().min(1).max(10).optional().describe("How many results (default 3)"),
      }),
      annotations: readOnly,
    },
    async ({ query, limit }) => {
      const hits = await searchKnowledge(knowledgeDir, query, limit ?? 3);
      if (hits.length === 0) return { content: [{ type: "text", text: `Nothing in the team knowledge matches "${query}".` }] };
      return json(hits);
    },
  );

  // ---------- Tools with side effects: only registered when explicitly allowed ----------

  if (options.allowWrites) {
    server.registerTool(
      "create_booking",
      {
        title: "Create booking",
        description:
          "Try to create a booking. Returns the HTTP status and response body. " +
          "A 400 with validation errors is a valid outcome to observe, not a tool failure.",
        inputSchema: z.object({
          guestName: z.string(),
          roomId: z.string().describe("A room id from list_rooms, for example r2"),
          guests: z.number().int(),
          checkIn: z.string().describe("YYYY-MM-DD"),
          checkOut: z.string().describe("YYYY-MM-DD"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async (booking) => json(await api("/api/bookings", { method: "POST", body: JSON.stringify(booking) })),
    );

    server.registerTool(
      "cancel_booking",
      {
        title: "Cancel booking",
        description: "Cancel (delete) a booking by id. Returns the HTTP status.",
        inputSchema: z.object({ id: z.string().min(1) }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ id }) => json(await api(`/api/bookings/${encodeURIComponent(id)}`, { method: "DELETE" })),
    );

    server.registerTool(
      "reset_test_data",
      {
        title: "Reset test data",
        description: "Delete every booking and restore the seed rooms. Use it to start an experiment from a clean state.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async () => {
        const { status } = await api("/api/test/reset", { method: "POST" });
        return status === 204 ? json({ status, reset: true }) : failure(`POST /api/test/reset returned ${status}`);
      },
    );
  }

  return server;
}
