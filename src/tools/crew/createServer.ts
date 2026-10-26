import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { acceptedContent, inputRequired, McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { renderBugReport } from "../../agents/triager/triager.ts";
import type { TriageItem } from "../../crew/contracts.ts";
import { advance, approve, createRun, latestRunId, loadRun, runDir, saveRun, type CrewRun, type RunStore, type Stage } from "../../crew/orchestrator.ts";
import { decisionsFor, renderRunSummary } from "../../crew/summary.ts";
import { DEFAULT_MAX_WAITING, wipLimitReason } from "../../crew/attention.ts";

// qa-crew: the whole crew as an MCP server, for the tools your team already uses.
// Claude Code, Cursor, Copilot or any MCP host can start a run, show what waits for you,
// and, only with a person's answer, approve a gate or file a bug.
//
// The assistant in your editor can ask; it cannot decide. Approving and filing ask the
// person directly (an MCP elicitation), and a host that cannot ask gets a refusal.

export interface CrewServerOptions {
  store: RunStore;
  stages: () => Stage[];
  /** Where filed bugs go: the tracker the Triager searches. */
  issuesDir?: string;
  /** Recorded in approvals, with "via MCP". */
  reviewer?: string;
  /** Allow runs whose gates approve themselves. Off by default: an assistant should not start one. */
  allowAutoGates?: boolean;
  /** Run stages in the background and return at once (the default). Tests wait instead. */
  background?: boolean;
  maxTokens?: number;
  /** How many runs may wait for a person at once (Chapter 13). Default 2. */
  maxWaiting?: number;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const failure = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], isError: true });

const GATE_FILES: Record<string, { label: string; read: string; edit: string }> = {
  analyze: { label: "the risk map", read: "risk-map.md", edit: "risk-map.json" },
  design: { label: "the test plan", read: "test-plan.md", edit: "test-plan.json" },
};

/** The client's identity for this request: on 2026-07-28 it rides in the request envelope, before that in initialize. */
function client(server: McpServer, ctx: unknown): { canAsk: boolean; name?: string } {
  const envelope = (ctx as { mcpReq?: { envelope?: { clientCapabilities?: { elicitation?: unknown }; clientInfo?: { name?: string } } } }).mcpReq?.envelope;
  const capabilities = envelope?.clientCapabilities ?? server.server.getClientCapabilities();
  const info = envelope?.clientInfo ?? server.server.getClientVersion();
  return { canAsk: !!capabilities?.elicitation, name: info?.name };
}

const CANNOT_ASK =
  "Refused: this host cannot ask the person directly (it does not support MCP elicitation), and an assistant's own " +
  "judgment is not an approval. Approve from a terminal instead: npm run crew -- approve";

/** Runs in progress in this process, so two requests never advance the same run at once. */
const running = new Map<string, Promise<CrewRun>>();

export function createCrewServer(options: CrewServerOptions): McpServer {
  const { store } = options;
  const issuesDir = path.resolve(options.issuesDir ?? "issues");
  const person = options.reviewer ?? process.env.QA_REVIEWER ?? "a person";
  const via = (ctx: unknown) => `${person} (via MCP${client(server, ctx).name ? `, ${client(server, ctx).name}` : ""})`;
  const server = new McpServer({ name: "qa-crew", version: "0.11.0" });
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

  async function find(runId?: string): Promise<CrewRun> {
    const id = runId ?? (await latestRunId(store));
    if (!id) throw new Error("No crew runs yet. Start one with crew_start.");
    return loadRun(store, id);
  }

  /** Advance a run, in the background unless the server was told to wait. */
  async function go(run: CrewRun): Promise<CrewRun | undefined> {
    if (running.has(run.id)) throw new Error(`Run ${run.id} is already running. Check it with crew_status.`);
    const job = advance(store, run, options.stages())
      .then(async (done) => {
        await writeFile(path.join(runDir(store, done.id), "summary.md"), await renderRunSummary(store, done));
        return done;
      })
      .finally(() => running.delete(run.id));
    running.set(run.id, job);
    if (options.background === false) return job;
    job.catch((error) => console.error(`qa-crew: run ${run.id} stopped: ${error instanceof Error ? error.message : error}`));
    return undefined;
  }

  async function statusText(run: CrewRun): Promise<string> {
    const lines = [`Run ${run.id} (${run.feature}): ${running.has(run.id) ? "running now" : run.status}${run.waitingAt ? `, waiting for approval of ${GATE_FILES[run.waitingAt]?.label ?? run.waitingAt}` : ""}.`];
    if (run.error) lines.push(run.error);
    for (const s of run.stages) lines.push(`- ${s.name}: ${s.status}${s.notes[0] ? `. ${s.notes[0]}` : ""}${s.error ? ` Error: ${s.error}` : ""}`);
    const decisions = await decisionsFor(store, run);
    if (decisions.length > 0) {
      lines.push("", "Decisions for the person you are helping (do not make them yourself):");
      for (const d of decisions) lines.push(`- (${d.minutes} min) ${d.text}`);
    }
    lines.push("", `Full summary: crew://runs/${run.id}/summary.md`);
    return lines.join("\n");
  }

  // ---------- Read-only: safe for an assistant to call whenever it likes ----------

  server.registerTool(
    "crew_status",
    {
      title: "Crew status",
      description: "Where a QA Crew run is (the latest one by default): each stage, what it found, and the decisions waiting for a person.",
      inputSchema: z.object({ runId: z.string().optional().describe("A run id; the latest run if omitted") }),
      annotations: readOnly,
    },
    async ({ runId }) => {
      try {
        return text(await statusText(await find(runId)));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "crew_review",
    {
      title: "Show what to review",
      description:
        "Show the file a person must review at the gate the run is waiting at (the risk map or the test plan), " +
        "and the JSON file to edit before approving. Use it to help the person review; never approve for them.",
      inputSchema: z.object({ runId: z.string().optional() }),
      annotations: readOnly,
    },
    async ({ runId }) => {
      try {
        const run = await find(runId);
        const gate = run.waitingAt ? GATE_FILES[run.waitingAt] : undefined;
        if (run.status !== "waiting-for-approval" || !gate) return text(`Run ${run.id} is not waiting for a review (status: ${run.status}).`);
        const dir = runDir(store, run.id);
        const body = await readFile(path.join(dir, gate.read), "utf8");
        return text(
          `Review ${gate.label} of run ${run.id}.\n` +
            `To change it, edit ${path.join(dir, gate.edit)} (for example "status": "rejected" on a risk, or remove a test case).\n` +
            `When the person is satisfied, they approve with crew_approve. The approval records a fingerprint of the file as it is then.\n\n${body}`,
        );
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // ---------- Start and continue: run agents, change nothing outside the run folder and tests/generated ----------

  server.registerTool(
    "crew_start",
    {
      title: "Start a crew run",
      description:
        "Start a QA Crew run for a requirements document: Analyst, Designer, Executor, Reviewer and Triager. " +
        "Returns at once; the run stops at the first gate for a person to review the risk map. Check it with crew_status.",
      inputSchema: z.object({
        feature: z.string().default("booking-rules").describe("The requirements document key, for example booking-rules"),
        auto: z.boolean().default(false).describe("Approve gates by policy instead of by a person. Usually refused."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ feature, auto }) => {
      if (auto && !options.allowAutoGates) {
        return failure("Refused: a run started from an assistant must stop at its gates for a person. Start it without auto.");
      }
      const refused = await wipLimitReason(store, options.maxWaiting ?? DEFAULT_MAX_WAITING);
      if (refused) return failure(`Refused: ${refused}`);
      const stages = options.stages();
      const run = await createRun(store, {
        feature,
        stages,
        gates: { analyze: auto ? "auto" : "human", design: auto ? "auto" : "human" },
        maxTokens: options.maxTokens,
      });
      const done = await go(run);
      return text(done ? await statusText(done) : `Started run ${run.id}. The Analyst is working; check progress with crew_status.`);
    },
  );

  server.registerTool(
    "crew_continue",
    {
      title: "Continue a crew run",
      description: "Continue a run that failed or ran out of budget. Finished stages are not repeated. It never approves a gate.",
      inputSchema: z.object({ runId: z.string().optional(), maxTokens: z.number().int().positive().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ runId, maxTokens }) => {
      const run = await find(runId);
      if (run.status === "waiting-for-approval") return failure(`Run ${run.id} waits for a person to approve ${GATE_FILES[run.waitingAt ?? ""]?.label}. Use crew_review, then crew_approve.`);
      if (run.status === "done") return text(`Run ${run.id} is done.`);
      if (maxTokens) {
        run.budget.maxTokens = maxTokens;
        await saveRun(store, run);
      }
      const done = await go(run);
      return text(done ? await statusText(done) : `Continuing run ${run.id}; check progress with crew_status.`);
    },
  );

  // ---------- Decisions: only with a person's answer ----------

  const approval = z.object({
    approve: z.boolean().describe("Approve and let the crew continue"),
    note: z.string().optional().describe("Why, or what you changed (recorded with the approval)"),
  });

  server.registerTool(
    "crew_approve",
    {
      title: "Approve a gate (asks the person)",
      description:
        "Ask the person to approve the gate the run waits at. The person answers directly; your own judgment is not an approval. " +
        "Hosts that cannot ask the person are refused.",
      inputSchema: z.object({ runId: z.string().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ runId }, ctx) => {
      const run = await find(runId);
      const gate = run.waitingAt ? GATE_FILES[run.waitingAt] : undefined;
      if (run.status !== "waiting-for-approval" || !gate) return failure(`Run ${run.id} is not waiting for an approval (status: ${run.status}).`);

      const answer = acceptedContent(ctx.mcpReq.inputResponses, "approval", approval);
      if (!answer && !client(server, ctx).canAsk) return failure(CANNOT_ASK);
      if (!answer) {
        if (ctx.mcpReq.inputResponses?.approval) return text("Not approved: the person declined or cancelled. Nothing changed.");
        return inputRequired({
          inputRequests: {
            approval: inputRequired.elicit({
              message: `Approve ${gate.label} of crew run ${run.id}? Review it first (crew_review). Your approval is recorded with your name and a fingerprint of ${gate.edit} as it is now.`,
              requestedSchema: approval,
            }),
          },
        });
      }
      if (!answer.approve) return text("Not approved. The run keeps waiting; edit the file and ask again when ready.");

      const approved = await approve(store, run, { by: via(ctx), note: answer.note });
      const done = await go(approved);
      return text(done ? await statusText(done) : `Approved ${gate.label}. Run ${run.id} continues; check it with crew_status.`);
    },
  );

  const filing = z.object({ file: z.boolean().describe("File this bug in the issue tracker") });

  server.registerTool(
    "crew_file_bug",
    {
      title: "File a draft bug report (asks the person)",
      description:
        "File one of the Triager's draft bug reports in the issue tracker, after the person confirms. " +
        "Duplicates of existing issues cannot be filed.",
      inputSchema: z.object({ runId: z.string().optional(), caseId: z.string().describe("The test case of the draft, for example TC-05") }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ runId, caseId }, ctx) => {
      const run = await find(runId);
      const triageFile = path.join(runDir(store, run.id), "triage.json");
      const items: TriageItem[] = existsSync(triageFile) ? JSON.parse(await readFile(triageFile, "utf8")) : [];
      const item = items.find((i) => i.caseId === caseId);
      if (!item) return failure(`Run ${run.id} has no triaged failure for ${caseId}.`);
      if (item.duplicateOf) return failure(`${caseId} is already reported as ${item.duplicateOf}. Add the evidence there instead.`);
      if (!item.bugReport) return failure(`${caseId} has no draft bug report (classification: ${item.classification}).`);
      const filedAs = (item as TriageItem & { filedAs?: string }).filedAs;
      if (filedAs) return text(`${caseId} was already filed as ${filedAs}.`);

      const answer = acceptedContent(ctx.mcpReq.inputResponses, "filing", filing);
      if (!answer && !client(server, ctx).canAsk) return failure(CANNOT_ASK.replace("an approval", "a decision to file").replace("Approve from a terminal instead: npm run crew -- approve", "File it by hand from the draft in the run folder."));
      if (!answer) {
        if (ctx.mcpReq.inputResponses?.filing) return text("Not filed: the person declined or cancelled.");
        return inputRequired({
          inputRequests: {
            filing: inputRequired.elicit({
              message: `File "${item.bugReport.title}" (${item.bugReport.severity}, ${item.bugReport.requirementIds.join(", ")}) in the issue tracker?`,
              requestedSchema: filing,
            }),
          },
        });
      }
      if (!answer.file) return text("Not filed.");

      const id = await fileIssue(issuesDir, item, via(ctx));
      (item as TriageItem & { filedAs?: string }).filedAs = id;
      await writeFile(triageFile, JSON.stringify(items, null, 2) + "\n");
      return text(`Filed as ${id} in ${path.relative(process.cwd(), issuesDir) || "."}.`);
    },
  );

  // ---------- Resources: every file of a run, for hosts that let you attach them ----------

  server.registerResource(
    "crew-run-file",
    new ResourceTemplate("crew://runs/{runId}/{file}", {
      list: async () => {
        const id = await latestRunId(store);
        if (!id) return { resources: [] };
        const dir = runDir(store, id);
        const drafts = existsSync(path.join(dir, "issues")) ? await readdir(path.join(dir, "issues")) : [];
        const files = [...(await readdir(dir)).filter((f) => /\.(md|json)$/.test(f)), ...drafts.filter((f) => f.startsWith("DRAFT-"))];
        return { resources: files.map((f) => ({ uri: `crew://runs/${id}/${f}`, name: `${id}/${f}`, mimeType: f.endsWith(".md") ? "text/markdown" : "application/json" })) };
      },
    }),
    { title: "Crew run file", description: "A file from a QA Crew run: summary.md, risk-map.md, test-plan.md, reviews.md, triage.md, their JSON, and draft bug reports (DRAFT-<case>.md)." },
    async (uri, { runId, file }) => {
      const name = path.basename(String(file));
      const target = path.join(runDir(store, String(runId)), name.startsWith("DRAFT-") ? "issues" : "", name);
      if (!existsSync(target)) throw new Error(`No file ${name} in run ${runId}.`);
      return { contents: [{ uri: uri.href, text: await readFile(target, "utf8"), mimeType: name.endsWith(".md") ? "text/markdown" : "application/json" }] };
    },
  );

  // ---------- Prompts: slash commands for the team's routines ----------

  server.registerPrompt(
    "review-gate",
    {
      title: "Review a crew gate with me",
      description: "Walk through the risk map or test plan a crew run is waiting on, as a second pair of eyes.",
      argsSchema: z.object({ runId: z.string().optional() }),
    },
    async ({ runId }) => {
      const run = await find(runId);
      const gate = run.waitingAt ? GATE_FILES[run.waitingAt] : undefined;
      const body = gate ? await readFile(path.join(runDir(store, run.id), gate.read), "utf8") : "(the run is not waiting at a gate)";
      return {
        messages: [{
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Help me review ${gate?.label ?? "this crew run"} (run ${run.id}). Be a skeptical test lead:\n` +
              "- Which items have weak or no evidence? Which scores would you challenge, and why?\n" +
              "- What is missing: risks or cases a good tester would expect for these requirements?\n" +
              "- Which items cite requirements, bugs or tests I should open myself?\n" +
              "Propose edits to the JSON file, but do not make them and do not approve: I decide, and I approve with crew_approve.\n\n" +
              body,
          },
        }],
      };
    },
  );

  server.registerPrompt(
    "crew-inbox",
    { title: "What is waiting for me", description: "The decisions every recent crew run is waiting on, most urgent first." },
    async () => {
      const id = await latestRunId(store);
      const status = id ? await statusText(await loadRun(store, id)) : "No crew runs yet.";
      return {
        messages: [{
          role: "user" as const,
          content: { type: "text" as const, text: `Summarize what QA Crew needs from me, most urgent first, in a short list. Do not act on any of it.\n\n${status}` },
        }],
      };
    },
  );

  return server;
}

/** Write a draft bug report into the tracker as the next ISSUE-NNNN. */
export async function fileIssue(issuesDir: string, item: TriageItem, by: string, today = new Date()): Promise<string> {
  await mkdir(issuesDir, { recursive: true });
  const numbers = (await readdir(issuesDir)).map((f) => Number(f.match(/^ISSUE-(\d+)/)?.[1] ?? 0));
  const id = `ISSUE-${String(Math.max(0, ...numbers) + 1).padStart(4, "0")}`;
  const r = item.bugReport!;
  const slug = r.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const draft = renderBugReport(item)!.split("\n").slice(1).join("\n").replace("_Draft written by the Triager agent. Review before filing._", "");
  const body = [
    `# ${id}: ${r.title}`,
    "",
    "- **Status:** open",
    `- **Filed:** ${today.toISOString().slice(0, 10)} by ${by}, from a QA Crew draft`,
    draft.trim(),
    "",
  ].join("\n");
  await writeFile(path.join(issuesDir, `${id}-${slug}.md`), body);
  return id;
}
