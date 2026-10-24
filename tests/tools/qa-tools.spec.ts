import { test, expect } from "@playwright/test";
import { connectMcpServers, loadMcpConfig, type McpServerConfig, type McpToolbox } from "../../src/mcp/connect.ts";
import { assertTestEnvironment, resolveInside } from "../../src/tools/qa-tools/safety.ts";

// Tests for the qa-tools MCP server. They launch it exactly as a host would,
// from .mcp.json, and talk to it over stdio. The booking app is the copy
// Playwright starts on port 3100 (see playwright.config.ts).

const APP_URL = `http://localhost:${process.env.APP_PORT ?? 3100}`;

async function qaToolsConfig(extraEnv: Record<string, string> = {}): Promise<McpServerConfig> {
  const servers = await loadMcpConfig(".mcp.json", { ...process.env, BOOKING_URL: APP_URL });
  const config = servers["qa-tools"];
  return { ...config, env: { ...config.env, ...extraEnv } };
}

function tool(toolbox: McpToolbox, name: string) {
  const found = toolbox.tools.find((t) => t.name === name);
  if (!found) throw new Error(`Tool ${name} not found. Have: ${toolbox.tools.map((t) => t.name).join(", ")}`);
  return found;
}

test.describe("qa-tools, default (read-only) configuration", () => {
  let toolbox: McpToolbox;

  test.beforeAll(async () => {
    toolbox = await connectMcpServers([{ name: "qa-tools", config: await qaToolsConfig() }]);
  });
  test.afterAll(async () => toolbox?.close());

  test("exposes only read-only tools", async () => {
    expect(toolbox.tools.map((t) => t.name).sort()).toEqual([
      "get_api_reference",
      "get_booking",
      "list_bookings",
      "list_requirements",
      "list_rooms",
      "list_test_files",
      "read_test_file",
      "recent_changes",
      "search_issues",
      "search_knowledge",
      "trace_requirements",
    ]);
  });

  test("advertises a JSON Schema for each tool's input", async () => {
    const schema = tool(toolbox, "get_booking").inputSchema;
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["id"]);
  });

  test("list_rooms returns the rooms from the live API", async () => {
    const rooms = JSON.parse(String(await tool(toolbox, "list_rooms").run({})));
    expect(rooms).toHaveLength(3);
    expect(rooms[0]).toMatchObject({ id: "r1", capacity: 1 });
  });

  test("get_booking explains a missing id instead of returning nothing", async () => {
    await expect(tool(toolbox, "get_booking").run({ id: "b999" })).rejects.toThrow(/No booking with id "b999"/);
  });

  test("invalid arguments come back as an error the model can read", async () => {
    await expect(tool(toolbox, "get_booking").run({ id: 42 })).rejects.toThrow(/Input validation error/);
  });

  test("read_test_file reads files inside the tests folder", async () => {
    const files = JSON.parse(String(await tool(toolbox, "list_test_files").run({})));
    expect(files).toContain("baseline/api.spec.ts");
    const source = String(await tool(toolbox, "read_test_file").run({ path: "baseline/api.spec.ts" }));
    expect(source).toContain("lists the available rooms");
  });

  test("list_requirements reads both Spec Kit specs and ODD feature documents", async () => {
    const docs = JSON.parse(String(await tool(toolbox, "list_requirements").run({})));
    expect(docs.map((d: { key: string; workflow: string }) => `${d.workflow}:${d.key}`)).toEqual([
      "sdd:booking-rules",
      "odd:max-stay-limit",
    ]);
    await expect(tool(toolbox, "list_requirements").run({ key: "nope" })).rejects.toThrow(/Available: booking-rules/);
  });

  test("read_test_file refuses to leave the tests folder", async () => {
    await expect(tool(toolbox, "read_test_file").run({ path: "../.env" })).rejects.toThrow(/outside the folder/);
  });
});

test.describe("qa-tools with writes enabled", () => {
  let toolbox: McpToolbox;

  test.beforeAll(async () => {
    toolbox = await connectMcpServers([
      { name: "qa-tools", config: await qaToolsConfig({ QA_TOOLS_ALLOW_WRITES: "true" }) },
    ]);
  });
  test.afterAll(async () => toolbox?.close());
  test.beforeEach(async () => {
    await tool(toolbox, "reset_test_data").run({});
  });

  test("adds the tools that change data", async () => {
    const names = toolbox.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["create_booking", "cancel_booking", "reset_test_data"]));
  });

  test("a rejected booking is an observation, not a tool failure", async () => {
    const result = JSON.parse(
      String(
        await tool(toolbox, "create_booking").run({
          guestName: "",
          roomId: "r1",
          guests: 1,
          checkIn: "2030-05-01",
          checkOut: "2030-05-02",
        }),
      ),
    );
    expect(result.status).toBe(400);
    expect(result.body.errors).toContain("guestName is required");
  });

  test("a read-only filter on the client hides the write tools again", async () => {
    const readOnly = await connectMcpServers([
      { name: "qa-tools", config: await qaToolsConfig({ QA_TOOLS_ALLOW_WRITES: "true" }), filter: { readOnly: true } },
    ]);
    try {
      expect(readOnly.tools.map((t) => t.name)).not.toContain("reset_test_data");
    } finally {
      await readOnly.close();
    }
  });
});

test("the server refuses to start against an unknown host", async () => {
  const config = await qaToolsConfig({ BOOKING_URL: "https://bookings.example.com" });
  await expect(connectMcpServers([{ name: "qa-tools", config }])).rejects.toThrow();
});

test("safety helpers", () => {
  expect(assertTestEnvironment("http://localhost:3000").port).toBe("3000");
  expect(() => assertTestEnvironment("https://prod.example.com")).toThrow(/not a known test environment/);
  expect(assertTestEnvironment("https://staging.example.test", ["staging.example.test"]).hostname).toBe("staging.example.test");
  expect(resolveInside("tests", "baseline/api.spec.ts")).toMatch(/tests[\\/]baseline[\\/]api\.spec\.ts$/);
  expect(() => resolveInside("tests", "../../etc/passwd")).toThrow();
  expect(() => resolveInside("tests", "/etc/passwd")).toThrow();
});
