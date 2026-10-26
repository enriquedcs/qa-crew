// Chapter 12: evaluate the crew's agents. Same inputs, several trials, a scorecard.
//
//   npm run eval                                  # analyst, designer, triager, reviewer; 3 trials each
//   npm run eval -- --suite analyst,reviewer      # only some suites
//   npm run eval -- --trials 5                    # more trials: a better estimate, more tokens
//   npm run eval -- --suite executor              # the slow suite: writes tests and runs Playwright
//   npm run eval -- --label flash-lite            # name the scorecard (default: the model)
//   npm run eval -- --fail-under 0.8              # exit 1 if any suite scores below 80% (Chapter 13)
//   npm run eval -- --compare out/evals/a.json out/evals/b.json
//
//   QA_MODEL_PROVIDER=mock npm run eval           # the scripted agents: what the harness itself does
//   QA_ANALYST_MODEL=... npm run eval -- --suite analyst   # try another model for one role
//
// Writes: out/evals/<label>.json and out/evals/<label>.md

import { modelForRole, loadEnv, readArtifact, writeArtifact } from "../agents/shared.ts";
import { renderComparison, renderScorecard, scoreOf, summarize, type Scorecard, type Trial } from "./scorecard.ts";
import { SUITES, connectSuiteTools } from "./suites.ts";

loadEnv();
const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

// ---- Compare two scorecards and stop ----

if (args.includes("--compare")) {
  const [a, b] = args.slice(args.indexOf("--compare") + 1);
  if (!a || !b) {
    console.error("Usage: npm run eval -- --compare out/evals/a.json out/evals/b.json");
    process.exit(1);
  }
  const text = renderComparison(await readArtifact<Scorecard>(a), await readArtifact<Scorecard>(b));
  console.log(text);
  process.exit(0);
}

// ---- Run the suites ----

const requested = option("suite")?.split(",").map((s) => s.trim());
const suites = SUITES.filter((s) => (requested ? requested.includes(s.name) : !s.slow));
const unknown = (requested ?? []).filter((r) => !SUITES.some((s) => s.name === r));
if (unknown.length > 0 || suites.length === 0) {
  console.error(`Unknown suite: ${unknown.join(", ")}. Suites: ${SUITES.map((s) => s.name).join(", ")}`);
  process.exit(1);
}

const trials = Math.max(1, Number(option("trials") ?? 3));
const mock = (process.env.QA_MODEL_PROVIDER ?? "").toLowerCase() === "mock";
const label = option("label") ?? (mock ? "mock" : (process.env.QA_MODEL ?? "model"));
const failUnder = option("fail-under") !== undefined ? Number(option("fail-under")) : undefined;

const card: Scorecard = { label, createdAt: new Date().toISOString(), trials, suites: [] };

for (const suite of suites) {
  const toolbox = await connectSuiteTools(suite);
  const results: Trial[] = [];
  let modelName = "";
  try {
    console.log(`\n${suite.name}: ${suite.description}`);
    for (let i = 1; i <= trials; i++) {
      // A fresh client per trial: no conversation, cache or script carries over.
      const model = modelForRole(suite.name, suite.script);
      modelName = `${model.provider} / ${model.model}`;
      const started = Date.now();
      try {
        const out = await suite.trial(model, toolbox.tools);
        const trial: Trial = { score: scoreOf(out.checks), ...out, seconds: (Date.now() - started) / 1000 };
        results.push(trial);
        const failed = out.checks.filter((c) => !c.passed).map((c) => c.name);
        console.log(`  trial ${i}: ${Math.round(trial.score * 100)}%  ${trial.usage.inputTokens} in / ${trial.usage.outputTokens} out  ${trial.seconds.toFixed(1)}s${failed.length ? `  missed: ${failed.join("; ")}` : ""}`);
      } catch (err) {
        // A quota or key error will not fix itself on the next trial: stop this suite, keep the others.
        const error = (err as Error).message.split("\n")[0];
        results.push({ score: 0, checks: [], usage: { inputTokens: 0, outputTokens: 0 }, steps: 0, seconds: (Date.now() - started) / 1000, error });
        console.log(`  trial ${i}: error: ${error}`);
        break;
      }
    }
  } finally {
    await toolbox.close();
  }
  card.suites.push(summarize(suite.name, modelName, results));
}

// ---- Report ----

const slug = label.replace(/[^\w.-]+/g, "-");
await writeArtifact(`out/evals/${slug}.json`, card);
const md = await writeArtifact(`out/evals/${slug}.md`, renderScorecard(card));

console.log("\nSuite       Score   Range       Tokens in/out (mean)");
for (const s of card.suites) {
  const range = `${Math.round(s.min * 100)}-${Math.round(s.max * 100)}%`;
  console.log(`  ${s.suite.padEnd(10)} ${`${Math.round(s.mean * 100)}%`.padStart(4)}   ${range.padEnd(10)}  ${s.tokens.inputTokens} / ${s.tokens.outputTokens}`);
}
console.log(`\nScorecard: ${md}`);

if (failUnder !== undefined) {
  const below = card.suites.filter((s) => s.mean < failUnder);
  if (below.length > 0) {
    console.log(`\nBelow ${Math.round(failUnder * 100)}%: ${below.map((s) => s.suite).join(", ")}`);
    process.exit(1);
  }
}
