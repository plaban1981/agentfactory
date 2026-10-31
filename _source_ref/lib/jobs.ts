import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

// Client for Cloudhike Jobs (https://cloudhike.dev/docs/jobs): it calls one of our routes later, from the internet.

const REQUEST_TIMEOUT_MS = 15_000;
// Signed job requests older than this are refused, so a captured request can't be replayed later.
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export class JobsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobsError";
  }
}

type EnqueueOptions = {
  delaySeconds?: number;
  timeoutSeconds?: number;
  retries?: number;
};

// Queues a signed POST of `body` to `path` on this app. Returns the Cloudhike run id.
export async function enqueueJob(path: string, body: unknown, { delaySeconds = 0, timeoutSeconds = 120, retries = 3 }: EnqueueOptions = {}) {
  const apiUrl = process.env.JOBS_API_URL;
  const apiKey = process.env.JOBS_API_KEY;
  if (!apiUrl || !apiKey) throw new JobsError("Set JOBS_API_URL and JOBS_API_KEY to run background jobs.");
  const target = jobTargetUrl(path);
  if ("error" in target) throw new JobsError(target.error);

  let response: Response;
  try {
    response = await fetch(`${apiUrl.replace(/\/+$/, "")}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ url: target.url, method: "POST", body, delaySeconds, timeoutSeconds, retries, callbackUrl: null }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new JobsError("Cloudhike Jobs couldn't be reached.");
  }
  if (!response.ok) throw new JobsError(`Cloudhike Jobs refused the job (HTTP ${response.status}).`);
  const { id } = (await response.json().catch(() => ({}))) as { id?: string };
  return id ?? null;
}

// Cloudhike calls jobs from the internet, so the app must be reachable at a public https URL.
export function jobTargetUrl(path: string): { url: string } | { error: string } {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  let url: URL | null = null;
  try {
    url = base ? new URL(path, base) : null;
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "https:" || ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(url.hostname)) {
    return {
      error: "Background jobs need to reach this app at a public https URL. Set NEXT_PUBLIC_APP_URL to your deployed URL or a tunnel such as ngrok.",
    };
  }
  return { url: url.toString() };
}

// Checks `x-cloudhike-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, keyed with JOBS_API_KEY.
export function verifyJobSignature(header: string | null, rawBody: string) {
  const apiKey = process.env.JOBS_API_KEY;
  if (!apiKey || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((part) => part.trim().split("=", 2) as [string, string]));
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = Buffer.from(createHmac("sha256", apiKey).update(`${timestamp}.${rawBody}`).digest("hex"));
  const given = Buffer.from(parts.v1);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
