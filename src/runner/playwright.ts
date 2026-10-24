import { spawn } from "node:child_process";

// Run Playwright tests and summarize the result in a form a model (or a human) can read.
// The full JSON report is large; agents need the outcome and the first lines of each error.

export interface TestOutcome {
  title: string;
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  durationMs: number;
  error?: string;
}

export interface RunSummary {
  file: string;
  passed: number;
  failed: number;
  tests: TestOutcome[];
  /** Set when Playwright could not run at all, for example a syntax error. */
  crash?: string;
}

const ANSI = /\x1b\[[0-9;]*m/g;

function shorten(text: string, max = 900): string {
  const clean = text.replace(ANSI, "").trim();
  return clean.length > max ? clean.slice(0, max) + "\n…" : clean;
}

interface JsonSuite {
  title: string;
  suites?: JsonSuite[];
  specs?: { title: string; tests: { results: { status: TestOutcome["status"]; duration: number; error?: { message?: string } }[] }[] }[];
}

function collect(suite: JsonSuite, prefix: string[], out: TestOutcome[]): void {
  const path = suite.title && !suite.title.endsWith(".ts") ? [...prefix, suite.title] : prefix;
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests) {
      const last = t.results[t.results.length - 1];
      if (!last) continue;
      out.push({
        title: [...path, spec.title].join(" › "),
        status: last.status,
        durationMs: last.duration,
        ...(last.error?.message ? { error: shorten(last.error.message) } : {}),
      });
    }
  }
  for (const child of suite.suites ?? []) collect(child, path, out);
}

export interface RunOptions {
  /** Port for the copy of the booking app this run starts. Keep it apart from your dev app and the main test run. */
  appPort?: number;
  timeoutMs?: number;
  cwd?: string;
}

export function runPlaywright(file: string, options: RunOptions = {}): Promise<RunSummary> {
  const { appPort = 3200, timeoutMs = 120_000, cwd = process.cwd() } = options;
  return new Promise((resolve) => {
    const child = spawn("npx", ["playwright", "test", file, "--reporter=json", "--retries=0"], {
      cwd,
      env: { ...process.env, APP_PORT: String(appPort), QA_RUN_GENERATED: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.on("close", () => {
      clearTimeout(timer);
      const summary: RunSummary = { file, passed: 0, failed: 0, tests: [] };
      try {
        const report = JSON.parse(stdout.slice(stdout.indexOf("{"))) as { suites: JsonSuite[]; errors?: { message?: string }[] };
        for (const suite of report.suites) collect(suite, [], summary.tests);
        if (report.errors?.length) summary.crash = shorten(report.errors.map((e) => e.message ?? "").join("\n"));
      } catch {
        summary.crash = shorten(stderr || stdout || "Playwright produced no report.");
      }
      summary.passed = summary.tests.filter((t) => t.status === "passed").length;
      summary.failed = summary.tests.length - summary.passed;
      if (summary.tests.length === 0 && !summary.crash) summary.crash = "No tests were found in the file.";
      resolve(summary);
    });
  });
}
