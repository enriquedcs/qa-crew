import path from "node:path";

// Guardrails that live in the tool server itself, so they hold no matter
// which agent, IDE or coding assistant is calling the tools.

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * Refuse to point tools at anything that is not a known test environment.
 * Local hosts are always allowed; add others (for example a shared staging host)
 * explicitly with QA_TOOLS_ALLOWED_HOSTS.
 */
export function assertTestEnvironment(rawUrl: string, extraHosts: string[] = []): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`BOOKING_URL "${rawUrl}" is not a valid URL.`);
  }
  const allowed = [...LOCAL_HOSTS, ...extraHosts.map((h) => h.trim().toLowerCase()).filter(Boolean)];
  if (!allowed.includes(url.hostname.toLowerCase())) {
    throw new Error(
      `Refusing to run against "${url.host}": it is not a known test environment. ` +
        `Allowed hosts: ${allowed.join(", ")}. Add a host to QA_TOOLS_ALLOWED_HOSTS only if it is safe to test against.`,
    );
  }
  return url;
}

/** Resolve a path the model asked for, and make sure it stays inside `root`. */
export function resolveInside(root: string, requested: string): string {
  const base = path.resolve(root);
  const target = path.resolve(base, requested);
  const relative = path.relative(base, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`"${requested}" is outside the folder this tool can read (${path.basename(base)}/).`);
  }
  return target;
}
