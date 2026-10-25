# Working in this repository

This is QA Crew, the companion code for the book *Agentic QA*: a small booking app
(`src/app/`) and a team of AI testing agents that test it (`src/agents/`, `src/crew/`).
These instructions are for any coding assistant working here: Claude Code, Cursor,
Copilot, Codex or another.

## Commands

- `npm run app`: the booking app on http://localhost:3000
- `npm test`: the test suite (Playwright starts its own copy of the app)
- `npm run typecheck`
- `npm run crew`: a QA Crew run from the terminal (`approve`, `status`, `continue`)

## QA Crew tools

Two MCP servers are configured in `.mcp.json`:

- `qa-tools`: read the booking app, its requirements, tests, past bugs and issues.
  The read-only tools are safe to use whenever they help.
- `qa-crew`: run the crew. `crew_status` and `crew_review` are read-only.

## Decisions that belong to a person

The crew proposes; people decide. As an assistant, you can help the person decide.
Never decide for them:

- **Do not approve gates.** `crew_approve` asks the person directly. Do not call it unless
  they asked you to, and never answer its question for them.
- **Do not file bugs.** `crew_file_bug` asks the person to confirm. Help them read the draft first.
- **Do not change what a test expects** to make it pass: not in `tests/`, not in a test plan,
  not in `tests/generated/`. A red test that checks the right thing is a finding.
- **Do not start runs with auto gates.** The server refuses them for a reason.
- **Do not promote generated tests** from `tests/generated/` into the suite without the person's review.

## Conventions

- Tests use the fixtures in `tests/support/fixtures.ts` and dates relative to today (`tests/support/dates.ts`).
- Tag every test with its case id and requirement ids, for example `{ tag: ["@TC-02", "@booking-rules:FR-005"] }`.
- Requirements live in `specs/` (Spec Kit) and `odd/tasks/` (ODD). Never invent a requirement id.
