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

## Following the book

Every chapter has a starting and a finished state, tagged in Git:

```bash
git checkout ch05-start   # where Chapter 5 begins
git checkout ch05-done    # the finished code for Chapter 5
```

## License

The code in this repository is released under the [MIT License](LICENSE). The book's text is not included and remains © Enrique A. De Coss.
