import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// One shape for requirements, whatever workflow produced them.
// Spec Kit specs (SDD) and ODD feature documents are both plain Markdown;
// these parsers turn them into the same list of requirements, so agents and
// tools never need to know which workflow a team uses.

export interface Requirement {
  /** Globally unique id, also used as the test tag: `booking-rules:FR-005` -> `@booking-rules:FR-005`. */
  id: string;
  /** The requirement's id inside its own document: `FR-005`, `S1`. */
  localId: string;
  text: string;
  /** Acceptance scenarios or oracles that say how to check this requirement. */
  checks: string[];
}

export interface RequirementsDocument {
  /** Short key shared by every requirement in the document: `booking-rules`, `max-stay-limit`. */
  key: string;
  title: string;
  workflow: "sdd" | "odd";
  file: string;
  requirements: Requirement[];
  /** Questions the document marks as unresolved. Each one is a risk until someone answers it. */
  openQuestions: string[];
}

const CLARIFICATION = /\[NEEDS CLARIFICATION:\s*([^\]]+)\]/g;

function openQuestionsIn(markdown: string): string[] {
  return [...markdown.matchAll(CLARIFICATION)].map((m) => m[1].trim());
}

/** Text between `## <heading>` and the next `## ` heading. */
function section(markdown: string, heading: string): string {
  const start = markdown.search(new RegExp(`^## ${heading}\\b.*$`, "m"));
  if (start === -1) return "";
  const rest = markdown.slice(start).replace(/^.*\n/, "");
  const end = rest.search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Parse a Spec Kit `spec.md`: functional requirements (FR-###) and the acceptance scenarios that cite them. */
export function parseSpecKitSpec(markdown: string, key: string, file = ""): RequirementsDocument {
  const title = markdown.match(/^# Feature Specification:\s*(.+)$/m)?.[1].trim() ?? key;

  const requirements: Requirement[] = [];
  for (const m of markdown.matchAll(/^- \*\*(FR-\d+)\*\*:\s*(.+)$/gm)) {
    requirements.push({ id: `${key}:${m[1]}`, localId: m[1], text: m[2].trim(), checks: [] });
  }

  // Acceptance scenarios ("1. **Given** ... *(FR-001, FR-002)*") become checks on the requirements they cite.
  for (const m of markdown.matchAll(/^\s*\d+\.\s+(\*\*Given\*\*.+)$/gm)) {
    const scenario = m[1].replace(/\*/g, "").replace(/\s*\((FR-\d+(?:,\s*FR-\d+)*)\)\s*$/, "").trim();
    for (const cited of m[1].match(/FR-\d+/g) ?? []) {
      requirements.find((r) => r.localId === cited)?.checks.push(scenario);
    }
  }

  return { key, title, workflow: "sdd", file, requirements, openQuestions: openQuestionsIn(markdown) };
}

/** Parse an ODD feature document (`odd/tasks/<feature>.md`): the `S#` items under `## Specs`. */
export function parseOddFeature(markdown: string, key: string, file = ""): RequirementsDocument {
  const heading = markdown.match(/^# (.+)$/m)?.[1].trim() ?? key;
  const title = heading.includes(":") ? heading.slice(heading.indexOf(":") + 1).trim() : heading;

  const requirements: Requirement[] = [];
  for (const m of section(markdown, "Specs").matchAll(/^- (S\d+)\s+(.+)$/gm)) {
    const [, localId, body] = m;
    const oracle = body.match(/Oracle:\s*([^]*?)(?=\s+Risk:|$)/)?.[1].trim();
    requirements.push({ id: `${key}:${localId}`, localId, text: body.trim(), checks: oracle ? [oracle] : [] });
  }

  // ODD records open questions in the log; count the ones explicitly marked as such.
  const logQuestions = [...section(markdown, "Log").matchAll(/open question[^:]*:\s*(.+)$/gim)].map((m) => m[1].trim());

  return {
    key,
    title,
    workflow: "odd",
    file,
    requirements,
    openQuestions: [...openQuestionsIn(markdown), ...logQuestions],
  };
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

/**
 * Load every requirements document in a project:
 *   specs/<NNN-name>/spec.md   (Spec Kit, SDD)
 *   odd/tasks/<name>.md        (ODD feature documents)
 */
export async function loadRequirements(root = "."): Promise<RequirementsDocument[]> {
  const docs: RequirementsDocument[] = [];

  const specsDir = path.join(root, "specs");
  for (const folder of await listDir(specsDir)) {
    const file = path.join(specsDir, folder, "spec.md");
    const markdown = await readFile(file, "utf8").catch(() => undefined);
    if (markdown === undefined) continue;
    docs.push(parseSpecKitSpec(markdown, folder.replace(/^\d+-/, ""), path.relative(root, file)));
  }

  const oddDir = path.join(root, "odd", "tasks");
  for (const name of await listDir(oddDir)) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(oddDir, name);
    docs.push(parseOddFeature(await readFile(file, "utf8"), name.replace(/\.md$/, ""), path.relative(root, file)));
  }

  return docs;
}
