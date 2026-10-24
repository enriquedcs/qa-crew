import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { RequirementsDocument } from "./requirements.ts";

// Traceability without a tool vendor: tests carry the requirement id as a
// Playwright tag (`{ tag: "@booking-rules:FR-005" }`), and this module matches
// tags against the requirements in specs/ and odd/tasks/.

export interface TagUse {
  tag: string;
  file: string;
  line: number;
}

export interface TraceReport {
  covered: { id: string; text: string; tests: TagUse[] }[];
  uncovered: { id: string; text: string; file: string }[];
  /** Tags in tests that match no requirement: the spec changed, or the tag has a typo. Either way, drift. */
  unknownTags: TagUse[];
  openQuestions: { key: string; question: string }[];
}

const TAG = /@([a-z0-9][a-z0-9-]*:(?:FR-\d+|S\d+))\b/g;

export async function findRequirementTags(testsDir = "tests"): Promise<TagUse[]> {
  const entries = await readdir(testsDir, { recursive: true, withFileTypes: true });
  const uses: TagUse[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(spec|test)\.[cm]?[jt]s$/.test(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((text, index) => {
      for (const m of text.matchAll(TAG)) {
        uses.push({ tag: m[1], file: path.relative(".", file).split(path.sep).join("/"), line: index + 1 });
      }
    });
  }
  return uses;
}

export function buildTraceReport(docs: RequirementsDocument[], uses: TagUse[]): TraceReport {
  const report: TraceReport = { covered: [], uncovered: [], unknownTags: [], openQuestions: [] };
  const known = new Set<string>();

  for (const doc of docs) {
    for (const req of doc.requirements) {
      known.add(req.id);
      const tests = uses.filter((u) => u.tag === req.id);
      if (tests.length > 0) report.covered.push({ id: req.id, text: req.text, tests });
      else report.uncovered.push({ id: req.id, text: req.text, file: doc.file });
    }
    for (const question of doc.openQuestions) report.openQuestions.push({ key: doc.key, question });
  }

  report.unknownTags = uses.filter((u) => !known.has(u.tag));
  return report;
}

export function formatTraceReport(report: TraceReport): string {
  const total = report.covered.length + report.uncovered.length;
  const lines = [`Requirements covered by tests: ${report.covered.length}/${total}`, ""];

  if (report.uncovered.length > 0) {
    lines.push("No test yet:");
    for (const r of report.uncovered) lines.push(`  - ${r.id}  ${r.text.slice(0, 90)}`);
    lines.push("");
  }
  if (report.unknownTags.length > 0) {
    lines.push("Tags that match no requirement (drift):");
    for (const u of report.unknownTags) lines.push(`  - @${u.tag}  ${u.file}:${u.line}`);
    lines.push("");
  }
  if (report.openQuestions.length > 0) {
    lines.push("Open questions:");
    for (const q of report.openQuestions) lines.push(`  - [${q.key}] ${q.question}`);
    lines.push("");
  }
  return lines.join("\n");
}
