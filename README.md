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
| `src/crew/` | The orchestrator: the crew as one run, with approval gates, a budget and a summary of your decisions (Chapter 9) |

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
