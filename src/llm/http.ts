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

/** Honor a Retry-After header in seconds, when the provider sends one. */
function retryAfterMs(res: Response): number | undefined {
  const seconds = Number(res.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
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
    let reason: string;
    try {
      res = await fetch(url, init);
      if (res.ok || !RETRYABLE_STATUSES.has(res.status) || attempt >= retries) return res;
      reason = `${res.status} ${res.statusText || "temporary error"}`.trim();
    } catch (error) {
      if (attempt >= retries) throw error;
      reason = `network error (${error instanceof Error ? error.message : String(error)})`;
    }
    const backoff = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
    const delayMs = Math.min((res && retryAfterMs(res)) ?? backoff, maxDelayMs);
    await res?.body?.cancel().catch(() => {});
    onRetry({ attempt: attempt + 1, retries, delayMs, reason });
    await sleep(delayMs);
  }
}
