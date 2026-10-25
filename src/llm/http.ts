// Model APIs fail in two ways. Some failures are temporary: the provider is overloaded (503, 529),
// you hit a rate limit (429), or the connection dropped. Others are permanent: a wrong key (401),
// an unknown model (404), a malformed request (400). Retrying a temporary failure is the right call;
// retrying a permanent one only wastes time. This helper retries the first kind and nothing else.

/** HTTP statuses that usually mean "try again later". */
export const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

export interface RetryOptions {
  /** Retries after the first attempt. Default: QA_MODEL_MAX_RETRIES, or 4. */
  retries?: number;
  /** Delay before the first retry; it doubles each time. Default 2000 ms. */
  baseDelayMs?: number;
  /** Upper bound for a single wait. Default 60 s. */
  maxDelayMs?: number;
  /** Replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each wait, so the user sees why the run paused. */
  onRetry?: (info: { attempt: number; retries: number; delayMs: number; reason: string }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const defaultOnRetry: NonNullable<RetryOptions["onRetry"]> = ({ attempt, retries, delayMs, reason }) =>
  console.error(`  model API: ${reason}; retrying in ${Math.round(delayMs / 1000)}s (${attempt}/${retries})`);

function retriesFromEnv(): number {
  const n = Number(process.env.QA_MODEL_MAX_RETRIES);
  return Number.isInteger(n) && n >= 0 ? n : 4;
}

/**
 * How long the provider asks us to wait: a Retry-After header in seconds, or Google's
 * RetryInfo in the body ("retryDelay": "18595s").
 */
export async function requestedDelayMs(res: Response): Promise<number | undefined> {
  const header = Number(res.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  try {
    const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(await res.clone().text());
    if (match) return Number(match[1]) * 1000;
  } catch {
    // No readable body: fall back to our own backoff.
  }
  return undefined;
}

/**
 * POST with retries for temporary failures. Returns the last response, which may still be an error:
 * the caller decides how to report it.
 */
export async function fetchWithRetry(url: string, init: RequestInit, options: RetryOptions = {}): Promise<Response> {
  const {
    retries = retriesFromEnv(),
    baseDelayMs = 2000,
    maxDelayMs = 60_000,
    sleep = defaultSleep,
    onRetry = defaultOnRetry,
  } = options;

  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    let requested: number | undefined;
    let reason: string;
    try {
      res = await fetch(url, init);
      if (res.ok || !RETRYABLE_STATUSES.has(res.status) || attempt >= retries) return res;
      requested = await requestedDelayMs(res);
      // A quota that resets in hours (a daily limit) is not a temporary error: stop now.
      if (requested !== undefined && requested > maxDelayMs) return res;
      reason = `${res.status} ${res.statusText || "temporary error"}`.trim();
    } catch (error) {
      if (attempt >= retries) throw error;
      reason = `network error (${error instanceof Error ? error.message : String(error)})`;
    }
    const backoff = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
    const delayMs = requested ?? backoff;
    await res?.body?.cancel().catch(() => {});
    onRetry({ attempt: attempt + 1, retries, delayMs, reason });
    await sleep(delayMs);
  }
}

/** An error message that says what to do, not only what the server answered. */
export async function describeApiError(provider: string, res: Response): Promise<string> {
  const wait = await requestedDelayMs(res);
  const body = await res.text();
  let hint = "";
  if (res.status === 429 && wait !== undefined && wait > 60_000) {
    hint = `\nQuota exhausted: the provider asks to wait about ${formatWait(wait)}. Switch QA_MODEL or provider, or raise your plan's limits.`;
  } else if (res.status === 401 || res.status === 403) {
    hint = "\nCheck QA_MODEL_API_KEY.";
  } else if (res.status === 404) {
    hint = "\nCheck QA_MODEL: the provider does not know this model name.";
  }
  return `${provider} API error ${res.status}: ${body}${hint}`;
}

function formatWait(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}
