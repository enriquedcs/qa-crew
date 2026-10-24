// Chapter 7: an exploratory testing session, run by an agent with a browser.
//
// Scripted tests check what you already know. A charter points an agent at what you
// don't: it explores the UI through Playwright MCP and writes session notes.
//
//   npm run app                                       # in one terminal
//   npm run ch07:explore                              # in another (needs a real model)
//   npm run ch07:explore -- "Explore the guests field with unusual input to discover validation gaps."
//
// Writes: out/explorer/session-<timestamp>.json

import { runAgent } from "../agent/runAgent.ts";
import type { JsonSchema } from "../llm/types.ts";
import { connectMcpServers, loadMcpConfig } from "../mcp/connect.ts";
import { loadEnv, modelOrMock, printEvents, writeArtifact } from "../agents/shared.ts";

loadEnv();
const BOOKING_URL = process.env.BOOKING_URL ?? "http://localhost:3000";

// A charter in the classic shape: Explore <target> with <resources> to discover <information>.
const charter =
  process.argv[2] ??
  "Explore the booking form with dates around today and back-to-back stays to discover problems with date handling and availability.";

interface SessionNotes {
  charter: string;
  coverage: string[];
  findings: { title: string; kind: "bug" | "question" | "risk"; steps: string[]; observed: string; expected: string }[];
  ideasForTests: string[];
}

const notesSchema: JsonSchema = {
  type: "object",
  properties: {
    charter: { type: "string" },
    coverage: { type: "array", items: { type: "string" }, description: "What you actually tried." },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          kind: { type: "string", enum: ["bug", "question", "risk"] },
          steps: { type: "array", items: { type: "string" } },
          observed: { type: "string" },
          expected: { type: "string", description: "What you expected, and why (cite the requirement or the UI text)." },
        },
        required: ["title", "kind", "steps", "observed", "expected"],
      },
    },
    ideasForTests: { type: "array", items: { type: "string" }, description: "Scripted tests worth adding after this session." },
  },
  required: ["charter", "coverage", "findings", "ideasForTests"],
};

const system = `You are an exploratory tester. You have a browser, a charter and a time box.
Explore the application at ${BOOKING_URL} the way a skilled human tester would:
- Take a snapshot to see the page, then act on elements by their reference from the snapshot.
- Vary one thing at a time and observe the result after every action (snapshot, status messages, console errors).
- Follow surprises. When something looks odd, try to reproduce it before you report it.
- Stay inside the charter. Note other interesting things as questions, do not chase them.
- Report only what you observed. Every bug needs steps that reproduce it.
When the charter is covered or you are close to your step budget, call submit_result with your session notes.`;

// Exploration needs a real model: a scripted one cannot react to what it sees.
let model;
try {
  model = modelOrMock(() => {
    throw new Error("a scripted mock cannot react to a page it has not seen");
  });
} catch (error) {
  console.error(`Exploratory sessions need a real model (${error instanceof Error ? error.message : error}).`);
  console.error("Copy .env.example to .env and set QA_MODEL_PROVIDER, QA_MODEL and QA_MODEL_API_KEY. See Chapter 2.");
  process.exit(1);
}

// Start from a clean app.
await fetch(new URL("/api/test/reset", BOOKING_URL), { method: "POST" });

const servers = await loadMcpConfig(".mcp.json");
const toolbox = await connectMcpServers([
  {
    name: "playwright",
    config: servers.playwright,
    // Enough to see and use the page; no file uploads, no arbitrary JavaScript, no network rewriting.
    filter: {
      include: [
        "browser_navigate",
        "browser_snapshot",
        "browser_click",
        "browser_type",
        "browser_fill_form",
        "browser_select_option",
        "browser_press_key",
        "browser_console_messages",
        "browser_close",
      ],
    },
  },
]);

try {
  console.log(`Charter: ${charter}\n`);
  const result = await runAgent<SessionNotes>({
    model,
    system,
    task: `Charter: ${charter}\nStart by navigating to ${BOOKING_URL}.`,
    tools: toolbox.tools,
    output: { schema: notesSchema },
    maxSteps: 30, // the time box
    onEvent: printEvents(),
  });

  if (!result.output) {
    console.log(`\nSession ended without notes (${result.status}).`);
  } else {
    const file = await writeArtifact(`out/explorer/session-${Date.now()}.json`, result.output);
    console.log(`\nFindings:`);
    for (const f of result.output.findings) console.log(`  [${f.kind}] ${f.title}`);
    console.log(`\nIdeas for scripted tests:`);
    for (const idea of result.output.ideasForTests) console.log(`  - ${idea}`);
    console.log(`\nNotes: ${file}`);
  }
} finally {
  await toolbox.close();
}
