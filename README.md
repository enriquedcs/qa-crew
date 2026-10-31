# QA Crew

Companion code for the book **[Agentic QA](https://leanpub.com/agenticqa)** by Enrique A. De Coss.

QA Crew is a team of AI testing agents — Analyst, Designer, Executor, Triager and Reviewer — that you build chapter by chapter. They test a small booking application that lives in this repository.

## Quick start

You need Node.js 20 or newer and Git.

```bash
git clone https://github.com/enriquedcs/qa-crew.git
cd qa-crew
git checkout ch01-start
npm install
npx playwright install
```

Start the booking app:

```bash
npm run app
```

Open <http://localhost:3000>. The data resets every time the server starts, so you can break it freely.

Run the baseline test suite (it starts its own copy of the app on port 3100):

```bash
npm test
```

## What's inside

| Path | What it is |
|---|---|
| `src/app/` | The booking app: a REST API and a single-page UI, with no runtime dependencies |
| `tests/baseline/` | A small hand-written Playwright suite — the "before" picture used in Chapter 1 |
| `src/llm/`, `src/agent/` | The vendor-neutral model layer and the `runAgent()` loop (Chapter 2) |
| `src/tools/qa-tools/` | The `qa-tools` MCP server: the booking API and the test suite as tools (Chapter 3) |
| `src/mcp/` | The bridge that turns MCP tools into agent tools (Chapter 3) |
| `.mcp.json` | MCP servers for this project, shared by the agents and by Claude Code |
| `specs/` | Spec Kit specifications (Spec-Driven Development), starting with the booking rules (Chapter 4) |
| `odd/tasks/` | ODD feature documents (Organic Driven Development), with a QA lens (Chapter 4) |
| `src/specs/` | Parsers that read both formats as one list of requirements, and the requirements-to-tests trace |
| `tests/spec/` | Executable acceptance checks, tagged with requirement ids such as `@booking-rules:FR-005` |
| `knowledge/` | Team knowledge the agents can search: past bug reports and notes (Chapter 5) |
| `src/crew/contracts.ts` | The hand-off contracts between agents: risk map, test plan, execution report |
| `src/agents/analyst/` | The Analyst: requirements to a reviewed risk map (Chapter 5) |
| `src/agents/designer/` | The Designer: risks to a curated test plan (Chapter 6) |
| `src/agents/executor/` | The Executor: test cases to Playwright tests, with quality gates and verified results (Chapter 7) |
| `tests/support/` | Fixtures, page objects and date helpers shared by humans and agents |
| `tests/generated/` | Drafts written by the Executor (not committed; promote the ones worth keeping) |
| `issues/` | The booking app's issue tracker, as Markdown (Chapter 8) |
| `src/agents/triager/` | The Triager: evidence, classification, guards and draft bug reports (Chapter 8) |
| `tests/triage-demo/` | A red build with four failures, each for a different reason (Chapter 8) |
| `src/agents/reviewer/` | The Reviewer: checks each generated test against its case, with a calibration set (Chapter 10) |
| `src/tools/crew/` | The crew as an MCP server for your IDE: status, review, approvals and filing that ask you first (Chapter 11) |
| `src/crew/` | The orchestrator: the crew as one run, with approval gates, a budget and a summary of your decisions (Chapter 9) |
| `src/evals/` | Evals: golden sets, scorers and repeated trials for every agent, with a scorecard per model (Chapter 12) |

More folders appear as you progress through the book (`src/agents/`, `src/tools/`, `src/crew/` and so on).

## Booking API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/rooms` | List rooms |
| `GET` | `/api/bookings` | List bookings |
| `GET` | `/api/bookings/:id` | Get one booking |
| `POST` | `/api/bookings` | Create a booking: `{ guestName, roomId, guests, checkIn, checkOut }` with dates as `YYYY-MM-DD` |
| `DELETE` | `/api/bookings/:id` | Cancel a booking |
| `POST` | `/api/test/reset` | Test-only: reset all data |

## Using qa-tools from your coding assistant

`qa-tools` is a standard MCP server, so any MCP host can use it. Claude Code picks up `.mcp.json` automatically. For other hosts, register the same command, `npx tsx src/tools/qa-tools/main.ts`, run from the repository root (Chapter 3 shows the config for Cursor, VS Code with Copilot and Codex).

The server only exposes read-only tools unless `QA_TOOLS_ALLOW_WRITES=true`, and it refuses to start if `BOOKING_URL` points anywhere other than localhost or a host listed in `QA_TOOLS_ALLOWED_HOSTS`.

To explore the tools by hand:

```bash
npx @modelcontextprotocol/inspector npx tsx src/tools/qa-tools/main.ts
```

## Using the crew from your coding assistant

Since Chapter 11, `.mcp.json` also registers `qa-crew`, the whole crew as an MCP server
(`npx tsx src/tools/crew/main.ts`). From Claude Code, Cursor or VS Code with Copilot you can start a run,
ask what is waiting for you, review a gate, approve it and file a bug, without leaving the editor:

| Tool | What it does | Who decides |
|---|---|---|
| `crew_status`, `crew_review` | Where a run is; the file to review at its gate | Read-only |
| `crew_start`, `crew_continue` | Start a run (it stops at each gate), or continue one | The assistant, with your permission |
| `crew_approve` | Approve the gate the run waits at | **You**: the server asks you directly |
| `crew_file_bug` | File a Triager draft in `issues/` | **You**: the server asks you directly |

Approving and filing use MCP elicitation: the server asks the person, not the assistant. A host that
cannot ask is refused. Prompts `review-gate` and `crew-inbox` appear as slash commands in hosts that
support MCP prompts, and every run file is a resource at `crew://runs/<id>/<file>`.

`AGENTS.md` (read by Codex, Cursor and Copilot, and by Claude Code through `CLAUDE.md`) tells assistants
which decisions are yours, and `.claude/settings.json` lets Claude Code call the read-only tools without asking.

## Running the crew

Each agent reads the previous one's output from `out/` and writes its own, so you can review every hand-off:

```bash
npm run ch05      # Analyst  -> out/analyst/booking-rules.risk-map.{md,json}   (review and edit the JSON)
npm run ch06      # Designer -> out/designer/booking-rules.test-plan.{md,json}
npm run ch07      # Executor -> tests/generated/*.spec.ts and out/executor/booking-rules.execution.json
npm run ch08      # Triager  -> out/triager/triage.md and draft bug reports in out/triager/issues/
```

Add `QA_MODEL_PROVIDER=mock` in front of any of them to watch a scripted run without an API key.

Or run them as one crew (Chapter 9). The run stops at two gates, after the risk map and after the test plan,
until you approve. Everything lives in `out/crew/<run id>/`, including `summary.md`, the list of decisions left for you:

```bash
npm run crew                 # start; stops at the risk map
npm run crew -- approve      # approve (after editing the file, if you want) and continue
npm run crew -- status       # where the latest run is
npm run crew -- continue     # after a failure, or with --max-tokens after the budget ran out
QA_MODEL_PROVIDER=mock npm run crew -- start --auto   # the whole crew, scripted, no gates
```

Since Chapter 10, a Reviewer checks every generated test against its case between the Executor and the
Triager, and sends findings back to the Executor for one revision. `npm run ch10` measures the Reviewer
on a calibration set of tests with planted defects.

## Export a test plan to your test case management tool

`npm run export-plan` writes the latest reviewed test plan as CSV, one row per step, next to the plan.
Import it with the CSV importer of Azure DevOps Test Plans, Jira with Xray or Zephyr, or TestRail, and map
the columns in the importer's wizard. The case id (TC-02) travels with every row, for traceability.

## Evaluating the crew (Chapter 12)

Every agent has an eval suite: a fixed input, a golden set written by a person, and scorers in plain code.
`npm run eval` runs each suite several times and writes a scorecard: score, range, the checks that are
unstable from one trial to the next, tokens and time.

```bash
npm run eval                                   # analyst, designer, triager, reviewer; 3 trials each
npm run eval -- --suite analyst --trials 5     # one suite, more trials
npm run eval -- --suite executor               # the slow suite: writes and runs Playwright tests
QA_ANALYST_MODEL=gemini-3.5-flash-lite npm run eval -- --suite analyst --label flash-lite
npm run eval -- --compare out/evals/claude-sonnet-5-5.json out/evals/flash-lite.json
QA_MODEL_PROVIDER=mock npm run eval            # the scripted agents: no API key
```

The inputs that come from a live run are frozen in `src/evals/fixtures/` (`npm run eval:freeze` records them again).

## QA Crew in CI (Chapter 13)

Three workflows in `.github/workflows/`:

| Workflow | When | What |
|---|---|---|
| `ci.yml` | every push and pull request | typecheck, tests, the crew with scripted models, the eval harness against `evals/baselines/mock.json` |
| `evals.yml` | by hand, and weekly | evals with a real model; fails under 80% or on a regression against `evals/baselines/<model>.json` |
| `crew.yml` | by hand | a crew run with a real model; each gate is a job in the `qa-crew-gate` environment, approved by a person |

For the real-model workflows, add the secret `QA_MODEL_API_KEY`, and optionally the variables `QA_MODEL_PROVIDER`,
`QA_MODEL` and `QA_MODEL_BASE_URL`. For `crew.yml`, create the environment `qa-crew-gate` with required reviewers.

The crew also treats your attention as a budget: every decision in a run summary has an estimated number of
minutes, the most important come first, and `npm run crew` refuses to start a new run while two others wait
for a person (`QA_CREW_MAX_WAITING`).

## The booking assistant (Chapter 14)

The app has an assistant: `POST /api/assistant` with `{ "message": "Is there a room for 3 people from 2030-05-01 to 2030-05-03?" }`
answers in plain words and may suggest one booking. It never books. It is a language model with read-only tools,
and its requirements are in `specs/002-booking-assistant/`.

```bash
npm run ch14                                   # the question set against the assistant, with code checks and a judge
ASSISTANT_MODEL_PROVIDER=mock npm run ch14     # the scripted assistant: two mistakes planted on purpose
npm test -- tests/assistant                    # the same rules as Playwright tests (scripted by default)
npm run eval -- --suite judge                  # calibrate the judge on labeled answers
```

The assistant's model comes from `ASSISTANT_MODEL_PROVIDER`, `ASSISTANT_MODEL`, `ASSISTANT_MODEL_API_KEY` and
`ASSISTANT_MODEL_BASE_URL`, falling back to the `QA_MODEL_*` settings. The judge uses `QA_JUDGE_MODEL`, or `QA_MODEL`.

## Requirements and traceability

Run `npm run trace` to see which requirements in `specs/` and `odd/tasks/` have tests, which do not, which test tags point at requirements that no longer exist, and which questions are still open. Add `-- --strict` in CI to fail the build on drift.

## Following the book

Every chapter has a starting and a finished state, tagged in Git:

```bash
git checkout ch05-start   # where Chapter 5 begins
git checkout ch05-done    # the finished code for Chapter 5
```

## License

The code in this repository is released under the [MIT License](LICENSE). The book's text is not included and remains © Enrique A. De Coss.
