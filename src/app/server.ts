import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.ts";
import { validateBooking } from "./validation.ts";
import { askAssistant, assistantModelFromEnv, type AssistantModel } from "./assistant.ts";

// A deliberately small booking app with no runtime dependencies,
// so readers can focus on testing it rather than on a framework.

const here = path.dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = path.join(here, "public", "index.html");

function sendJson(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function createApp(store = new Store(), assistant: AssistantModel | undefined = assistantModelFromEnv()) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = url;
    const method = req.method ?? "GET";

    try {
      if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const html = await readFile(indexHtmlPath, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
        return;
      }

      if (method === "GET" && pathname === "/api/health") return sendJson(res, 200, { status: "ok" });
      if (method === "GET" && pathname === "/api/rooms") return sendJson(res, 200, store.listRooms());
      if (method === "GET" && pathname === "/api/bookings") return sendJson(res, 200, store.listBookings());

      if (method === "POST" && pathname === "/api/bookings") {
        const body = await readJsonBody(req);
        if (body === undefined) return sendJson(res, 400, { errors: ["request body must be valid JSON"] });
        const result = validateBooking(body, store);
        if (!result.ok || !result.value) return sendJson(res, 400, { errors: result.errors });
        return sendJson(res, 201, store.addBooking(result.value));
      }

      // Chapter 14: the booking assistant. Answers and suggests; never books.
      if (method === "POST" && pathname === "/api/assistant") {
        const body = (await readJsonBody(req)) as { message?: unknown } | undefined;
        const message = typeof body?.message === "string" ? body.message.trim() : "";
        if (!message) return sendJson(res, 400, { errors: ["message is required"] });
        if (message.length > 2000) return sendJson(res, 400, { errors: ["message is too long"] });
        if (!assistant) return sendJson(res, 503, { errors: ["the assistant is not configured: set ASSISTANT_MODEL or QA_MODEL"] });
        const reply = await askAssistant(message, store, assistant());
        return reply ? sendJson(res, 200, reply) : sendJson(res, 502, { errors: ["the assistant did not answer"] });
      }

      const bookingMatch = pathname.match(/^\/api\/bookings\/([^/]+)$/);
      if (bookingMatch) {
        const id = decodeURIComponent(bookingMatch[1]);
        if (method === "GET") {
          const booking = store.getBooking(id);
          return booking ? sendJson(res, 200, booking) : sendJson(res, 404, { errors: ["booking not found"] });
        }
        if (method === "DELETE") {
          return store.deleteBooking(id) ? sendJson(res, 204) : sendJson(res, 404, { errors: ["booking not found"] });
        }
      }

      // Test-only helper so suites can start from a clean state.
      if (method === "POST" && pathname === "/api/test/reset") {
        store.reset();
        return sendJson(res, 204);
      }

      sendJson(res, 404, { errors: ["not found"] });
    } catch (error) {
      console.error(error);
      sendJson(res, 500, { errors: ["internal server error"] });
    }
  });
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    process.loadEnvFile?.();
  } catch {
    // No .env file: the assistant uses the environment, or answers 503.
  }
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => {
    console.log(`Booking app running at http://localhost:${port}`);
  });
}
