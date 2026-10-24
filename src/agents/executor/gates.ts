// Quality gates for generated tests. They run BEFORE a test is saved, on every
// write, for every host. A test that fails a gate is never written, and the
// agent gets the reasons back so it can fix them.

export interface GateResult {
  errors: string[];
  warnings: string[];
}

interface Rule {
  test: RegExp;
  message: string;
}

const FORBIDDEN: Rule[] = [
  { test: /\b(test|it|describe)\.(only)\b/, message: "Remove .only: it silently skips every other test in the run." },
  { test: /\b(test|it|describe)\.(skip|fixme)\b/, message: "Do not skip tests. If the test cannot pass, report why instead." },
  { test: /\btest\.fail\s*\(/, message: "Do not mark tests as expected failures. Only a human may do that, for a reported bug." },
  { test: /\bwaitForTimeout\s*\(/, message: "Do not sleep. Wait for a condition (expect(...).toBeVisible(), toHaveText(...))." },
  { test: /\bexpect\s*\(\s*(true|false|1|0)\s*\)/, message: "This assertion cannot fail. Assert on the response or the page." },
  { test: /['"`]\d{4}-\d{2}-\d{2}['"`]/, message: "Do not hard-code dates; they go stale. Use daysFromToday(n) or the checkInDays/checkOutDays options." },
  { test: /from\s+['"](?!@playwright\/test['"]|\.\.\/support\/)[^'"]+['"]/, message: "Only import from @playwright/test or ../support/." },
  { test: /\bprocess\.env\b|\bchild_process\b|\bfs\b\./, message: "Generated tests may not read the environment, files or processes." },
];

const WARNINGS: Rule[] = [
  { test: /\.locator\(\s*['"`][.#\[]/, message: "CSS selectors are brittle. Prefer getByRole, getByLabel or the BookingPage page object." },
  { test: /\bforce:\s*true\b/, message: "force: true hides real usability bugs. Remove it unless you can justify it." },
  { test: /\.toBeTruthy\(\)|\.ok\(\)\)\.toBe/, message: "Weak assertion: check the exact status code or value, not just truthiness." },
];

export function checkGeneratedTest(code: string, opts: { caseId?: string } = {}): GateResult {
  const errors = FORBIDDEN.filter((r) => r.test.test(code)).map((r) => r.message);
  const warnings = WARNINGS.filter((r) => r.test.test(code)).map((r) => r.message);

  const assertions = code.match(/\bexpect\s*\(/g)?.length ?? 0;
  if (assertions === 0) errors.push("The test has no assertions. A test that cannot fail proves nothing.");

  if (!/\btest\s*\(/.test(code)) errors.push("No test() found.");

  if (opts.caseId && !code.includes(`@${opts.caseId}`)) {
    errors.push(`Tag the test with its case id, for example { tag: ["@${opts.caseId}", "@booking-rules:FR-005"] }.`);
  }
  if (!/@[a-z0-9-]+:(FR-\d+|S\d+)/.test(code)) {
    errors.push('Tag the test with the requirement it checks, for example "@booking-rules:FR-005".');
  }

  return { errors, warnings };
}
