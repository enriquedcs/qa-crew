import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Usage } from "../llm/types.ts";

// The orchestrator runs the crew as a fixed workflow: stages in order, a gate between stages
// where a human (or a policy) approves the hand-off, a token budget for the whole run, and a
// run file on disk so any run can stop, wait and continue later.
//
// It knows nothing about QA. The models decide inside each stage; code decides what runs next.

export type StageStatus = "pending" | "running" | "done" | "skipped" | "failed";
export type RunStatus = "running" | "waiting-for-approval" | "done" | "failed" | "over-budget";
/** human: the run stops until someone approves. auto: a policy approves and the run goes on. */
export type GateMode = "human" | "auto";

export interface StageRecord {
  name: string;
  status: StageStatus;
  startedAt?: string;
  finishedAt?: string;
  usage: Usage;
  /** Files this stage wrote, relative to the run folder. */
  artifacts: string[];
  notes: string[];
  /** The file a human reviews at the gate after this stage. */
  review?: string;
  error?: string;
}

export interface Approval {
  /** The gate sits after this stage. */
  gate: string;
  mode: GateMode;
  by: string;
  at: string;
  /** What was approved, and its fingerprint at that moment. */
  artifact?: string;
  sha256?: string;
  note?: string;
}

export interface CrewRun {
  id: string;
  feature: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  /** Gates, by the stage they follow. A stage with no gate hands off directly. */
  gates: Record<string, GateMode>;
  budget: { maxTokens: number };
  usage: Usage;
  stages: StageRecord[];
  approvals: Approval[];
  /** Set while the run waits: the gate that needs approval. */
  waitingAt?: string;
  error?: string;
}

export interface StageContext {
  run: CrewRun;
  /** The run folder. */
  dir: string;
  /** The path of a file inside the run folder. */
  file(name: string): string;
  exists(name: string): boolean;
  readJson<T>(name: string): Promise<T>;
  /** Write a file into the run folder and return its name. */
  write(name: string, content: string | object): Promise<string>;
  /** Tokens left in the run's budget, counting what this stage has used so far. */
  tokensLeft(usedInStage?: number): number;
  log(event: Record<string, unknown>): Promise<void>;
}

export interface StageResult {
  usage?: Usage;
  artifacts?: string[];
  notes?: string[];
  /** The file a human should review before the next stage starts. */
  review?: string;
  /** True when the stage had nothing to do, for example no failures to triage. */
  skipped?: boolean;
}

export interface Stage {
  name: string;
  /** One line for status output: who does what. */
  title: string;
  run(ctx: StageContext): Promise<StageResult>;
}

export interface RunStore {
  /** Folder that holds one folder per run. */
  root: string;
  now?: () => Date;
}

const total = (u: Usage) => u.inputTokens + u.outputTokens;

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

export function runDir(store: RunStore, id: string): string {
  return path.join(store.root, id);
}

export async function saveRun(store: RunStore, run: CrewRun): Promise<void> {
  run.updatedAt = (store.now?.() ?? new Date()).toISOString();
  const dir = runDir(store, run.id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "run.json"), JSON.stringify(run, null, 2) + "\n");
}

export async function loadRun(store: RunStore, id: string): Promise<CrewRun> {
  const file = path.join(runDir(store, id), "run.json");
  if (!existsSync(file)) throw new Error(`No crew run "${id}" in ${store.root}.`);
  return JSON.parse(await readFile(file, "utf8")) as CrewRun;
}

/** The most recent run, by id (ids start with a timestamp). */
export async function latestRunId(store: RunStore): Promise<string | undefined> {
  if (!existsSync(store.root)) return undefined;
  const ids = (await readdir(store.root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  return ids.sort().at(-1);
}

export interface NewRunOptions {
  feature: string;
  stages: Stage[];
  gates?: Record<string, GateMode>;
  maxTokens?: number;
}

export async function createRun(store: RunStore, options: NewRunOptions): Promise<CrewRun> {
  const now = (store.now?.() ?? new Date()).toISOString();
  const run: CrewRun = {
    id: `${stamp(new Date(now))}-${options.feature}`,
    feature: options.feature,
    createdAt: now,
    updatedAt: now,
    status: "running",
    gates: options.gates ?? {},
    budget: { maxTokens: options.maxTokens ?? 400_000 },
    usage: { inputTokens: 0, outputTokens: 0 },
    stages: options.stages.map((s) => ({ name: s.name, status: "pending", usage: { inputTokens: 0, outputTokens: 0 }, artifacts: [], notes: [] })),
    approvals: [],
  };
  await saveRun(store, run);
  return run;
}

async function fingerprint(file: string): Promise<string | undefined> {
  if (!existsSync(file)) return undefined;
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function context(store: RunStore, run: CrewRun): StageContext {
  const dir = runDir(store, run.id);
  const file = (name: string) => path.join(dir, name);
  return {
    run,
    dir,
    file,
    exists: (name) => existsSync(file(name)),
    readJson: async <T>(name: string) => JSON.parse(await readFile(file(name), "utf8")) as T,
    write: async (name, content) => {
      await mkdir(path.dirname(file(name)), { recursive: true });
      await writeFile(file(name), typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
      return name;
    },
    tokensLeft: (usedInStage = 0) => run.budget.maxTokens - total(run.usage) - usedInStage,
    log: (event) => appendFile(file("events.jsonl"), JSON.stringify({ at: (store.now?.() ?? new Date()).toISOString(), ...event }) + "\n"),
  };
}

const approved = (run: CrewRun, gate: string) => run.approvals.some((a) => a.gate === gate);

/**
 * Run stages until the run is done, waits at a human gate, fails, or runs out of budget.
 * Safe to call again: finished stages are never repeated, and a failed stage is retried.
 */
export async function advance(store: RunStore, run: CrewRun, stages: Stage[]): Promise<CrewRun> {
  const ctx = context(store, run);
  const byName = new Map(stages.map((s) => [s.name, s]));
  run.status = "running";
  run.error = undefined;

  for (let i = 0; i < run.stages.length; i++) {
    const record = run.stages[i];
    if (record.status === "done" || record.status === "skipped") continue;

    // The gate between the previous stage and this one.
    const previous = run.stages[i - 1];
    const mode = previous ? run.gates[previous.name] : undefined;
    if (previous && mode && !approved(run, previous.name)) {
      if (mode === "human") {
        run.status = "waiting-for-approval";
        run.waitingAt = previous.name;
        await ctx.log({ type: "waiting", gate: previous.name, review: previous.review });
        await saveRun(store, run);
        return run;
      }
      await recordApproval(store, run, previous, { mode: "auto", by: "policy" });
    }

    if (ctx.tokensLeft() <= 0) {
      run.status = "over-budget";
      run.error = `The run used ${total(run.usage)} of its ${run.budget.maxTokens} tokens before "${record.name}". Raise the budget and continue, or stop here.`;
      await ctx.log({ type: "over-budget", stage: record.name, used: total(run.usage) });
      await saveRun(store, run);
      return run;
    }

    const stage = byName.get(record.name);
    if (!stage) throw new Error(`No implementation for stage "${record.name}".`);

    record.status = "running";
    record.startedAt = (store.now?.() ?? new Date()).toISOString();
    record.error = undefined;
    await ctx.log({ type: "stage-start", stage: record.name });
    await saveRun(store, run);

    try {
      const result = await stage.run(ctx);
      const usage = result.usage ?? { inputTokens: 0, outputTokens: 0 };
      record.usage = { inputTokens: record.usage.inputTokens + usage.inputTokens, outputTokens: record.usage.outputTokens + usage.outputTokens };
      run.usage = { inputTokens: run.usage.inputTokens + usage.inputTokens, outputTokens: run.usage.outputTokens + usage.outputTokens };
      record.artifacts = [...new Set([...record.artifacts, ...(result.artifacts ?? [])])];
      record.notes = result.notes ?? [];
      record.review = result.review;
      record.status = result.skipped ? "skipped" : "done";
      record.finishedAt = (store.now?.() ?? new Date()).toISOString();
      await ctx.log({ type: "stage-end", stage: record.name, status: record.status, tokens: total(usage) });
      await saveRun(store, run);
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      record.finishedAt = (store.now?.() ?? new Date()).toISOString();
      run.status = "failed";
      run.error = `Stage "${record.name}" failed: ${record.error}`;
      await ctx.log({ type: "stage-failed", stage: record.name, error: record.error });
      await saveRun(store, run);
      return run;
    }
  }

  run.status = "done";
  run.waitingAt = undefined;
  await ctx.log({ type: "run-done", tokens: total(run.usage) });
  await saveRun(store, run);
  return run;
}

async function recordApproval(store: RunStore, run: CrewRun, stage: StageRecord, who: { mode: GateMode; by: string; note?: string }) {
  const artifact = stage.review;
  const sha256 = artifact ? await fingerprint(path.join(runDir(store, run.id), artifact)) : undefined;
  const approval: Approval = {
    gate: stage.name,
    mode: who.mode,
    by: who.by,
    at: (store.now?.() ?? new Date()).toISOString(),
    ...(artifact ? { artifact } : {}),
    ...(sha256 ? { sha256 } : {}),
    ...(who.note ? { note: who.note } : {}),
  };
  run.approvals.push(approval);
  await context(store, run).log({ type: "approved", ...approval });
}

/**
 * A human approves the gate the run is waiting at. The approval records who, when, and a
 * fingerprint of the reviewed file as it was at that moment, edits included.
 */
export async function approve(store: RunStore, run: CrewRun, who: { by: string; note?: string }): Promise<CrewRun> {
  if (run.status !== "waiting-for-approval" || !run.waitingAt) {
    throw new Error(`Run ${run.id} is not waiting for an approval (status: ${run.status}).`);
  }
  const stage = run.stages.find((s) => s.name === run.waitingAt)!;
  await recordApproval(store, run, stage, { mode: "human", ...who });
  run.waitingAt = undefined;
  run.status = "running";
  await saveRun(store, run);
  return run;
}

/** Has the reviewed file changed since it was approved? */
export async function changedSinceApproval(store: RunStore, run: CrewRun, approval: Approval): Promise<boolean> {
  if (!approval.artifact || !approval.sha256) return false;
  return (await fingerprint(path.join(runDir(store, run.id), approval.artifact))) !== approval.sha256;
}
