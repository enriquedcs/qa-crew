import { readFile } from "node:fs/promises";
import type { EvidencePack, Failure } from "../../crew/contracts.ts";
import { runPlaywright, type RunSummary } from "../../runner/playwright.ts";
import { errorHeadline } from "../executor/executor.ts";

// Before a model looks at a failure, code gathers the facts that are cheap to get
// and expensive to guess: does it fail again? the same way? is the app even up?
// The Triager reasons about this evidence; it does not have to collect it.

const ENVIRONMENT_SIGNS = /ECONNREFUSED|ECONNRESET|ENOTFOUND|webServer|Timed out waiting .* from config|net::ERR_/i;

/** Turn the failing tests of a Playwright run into Failures. */
export function failuresFrom(summary: RunSummary): Failure[] {
  if (summary.crash) return [{ file: summary.file, title: "(the file did not run)", error: summary.crash }];
  return summary.tests
    .filter((t) => t.status !== "passed" && t.status !== "skipped")
    .map((t) => ({ file: summary.file, title: t.title, error: t.error ?? t.status }));
}

/** The comparable part of an error: its first meaningful line, without timings. */
export function signatureOf(error = ""): string {
  return errorHeadline(error).replace(/\d+(\.\d+)?\s?ms/g, "<n>ms").trim();
}

export interface EvidenceOptions {
  /** Extra runs on top of the original failing one. */
  reruns?: number;
  appPort?: number;
}

export async function collectEvidence(failure: Failure, options: EvidenceOptions = {}): Promise<EvidencePack> {
  const { reruns = 2, appPort = 3200 } = options;
  const runs: EvidencePack["runs"] = [{ status: "failed", error: failure.error }];

  for (let i = 0; i < reruns; i++) {
    const summary = await runPlaywright(failure.file, { appPort });
    const result = failure.title
      ? summary.tests.find((t) => t.title === failure.title || t.title.endsWith(failure.title))
      : (summary.tests.find((t) => t.status !== "passed") ?? summary.tests[0]);
    if (summary.crash || !result) runs.push({ status: "crashed", error: summary.crash ?? "The test was not found in the re-run." });
    else runs.push({ status: result.status, ...(result.error ? { error: result.error } : {}) });
  }

  const first = signatureOf(failure.error);
  const consistent = runs.every((r) => r.status === "failed" && signatureOf(r.error) === first);
  const appHealthy = !runs.some((r) => ENVIRONMENT_SIGNS.test(r.error ?? ""));
  let testSource = "";
  try {
    testSource = await readFile(failure.file, "utf8");
  } catch {
    testSource = "(could not read the test file)";
  }

  return { failure, runs, consistent, appHealthy, testSource };
}
