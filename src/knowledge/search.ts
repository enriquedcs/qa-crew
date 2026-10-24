import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// Retrieval in its simplest useful form: split the team's Markdown notes into
// sections, score each section by the query words it contains, return the best.
// No embeddings, no vector database. For a few hundred documents this is fast,
// explainable and good enough; Chapter 12 shows how to measure when it is not.

export interface KnowledgeHit {
  file: string;
  title: string;
  score: number;
  text: string;
}

interface Chunk {
  file: string;
  title: string;
  text: string;
  words: string[];
}

const STOP_WORDS = new Set(
  "a an and are as at be but by for from has have in is it its of on or that the this to was were when with".split(" "),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
    .map((w) => w.replace(/(ings|ing|ed|es|s)$/, "") || w); // crude stemming: "bookings" ~ "booking" ~ "booked"
}

async function loadChunks(root: string): Promise<Chunk[]> {
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  const chunks: Chunk[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "README.md") continue;
    const file = path.join(entry.parentPath, entry.name);
    const markdown = await readFile(file, "utf8");
    const title = markdown.match(/^# (.+)$/m)?.[1].trim() ?? entry.name;
    // One chunk per document is enough for short bug reports; split long notes by "## " sections.
    const sections = markdown.split(/^(?=## )/m);
    for (const section of sections) {
      chunks.push({
        file: path.relative(root, file).split(path.sep).join("/"),
        title,
        text: section.trim(),
        words: tokenize(section + " " + title),
      });
    }
  }
  return chunks;
}

/** Return the most relevant sections for a query, best first. */
export async function searchKnowledge(root: string, query: string, limit = 3): Promise<KnowledgeHit[]> {
  const chunks = await loadChunks(root);
  const queryWords = [...new Set(tokenize(query))];
  if (queryWords.length === 0 || chunks.length === 0) return [];

  // Rarer words count more (a light-weight IDF): "concurrency" says more than "booking".
  const docFreq = new Map<string, number>();
  for (const chunk of chunks) for (const w of new Set(chunk.words)) docFreq.set(w, (docFreq.get(w) ?? 0) + 1);

  return chunks
    .map((chunk) => {
      const score = queryWords.reduce((sum, w) => {
        if (!chunk.words.includes(w)) return sum;
        return sum + Math.log(1 + chunks.length / (docFreq.get(w) ?? 1));
      }, 0);
      return { file: chunk.file, title: chunk.title, score: Math.round(score * 100) / 100, text: chunk.text };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
