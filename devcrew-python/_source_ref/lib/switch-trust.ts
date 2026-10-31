import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { agents, db, switchConnections, type SwitchConnection } from "@/db";
import type { SwitchTrustOverview } from "@/lib/ai-team";
import { decrypt } from "@/lib/crypto";
import { enqueueJob, JobsError } from "@/lib/jobs";

// Client for the Switch Trust API (https://docs.switchagents.ai/switch-trust/api-reference).
// API keys are pinned by Switch Trust to one tenant and one workspace, which are discovered from the key.

const REQUEST_TIMEOUT_MS = 20_000;
// Only hosts on this domain ever receive an API key.
const ALLOWED_HOST = "switchagents.ai";
// Leading labels that name an edge service rather than an instance.
const EDGE_LABELS = ["app", "api", "ingestion"];
// Identifiers interpolated into request paths must be plain path segments.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

export const SWITCH_SCAN_JOB_PATH = "/api/jobs/switch-scan";

export class SwitchTrustError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SwitchTrustError";
  }
}

// The canonical https origin of a Switch Trust instance, or null when it isn't one.
export function normalizeSwitchInstance(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (host !== ALLOWED_HOST && !host.endsWith(`.${ALLOWED_HOST}`)) return null;
  return url.origin;
}

// app.switchagents.ai → api.switchagents.ai: the REST API lives on the deployment's api. host.
function apiOrigin(instance: string) {
  const url = new URL(instance);
  const [head, ...rest] = url.hostname.split(".");
  const base = EDGE_LABELS.includes(head) && rest.length > 1 ? rest.join(".") : url.hostname;
  url.hostname = `api.${base}`;
  return url.origin;
}

function segment(value: string) {
  if (!SAFE_SEGMENT.test(value)) throw new SwitchTrustError("Switch Trust returned an unexpected identifier.");
  return encodeURIComponent(value);
}

type Credentials = { instance: string; apiKey: string };

async function request<T>(
  { instance, apiKey }: Credentials,
  method: "GET" | "POST" | "PUT",
  path: string,
  { body, query }: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
): Promise<T> {
  const url = new URL(path, apiOrigin(instance));
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `ApiKey ${apiKey}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new SwitchTrustError("Couldn't reach Switch Trust. Check the instance URL and try again.");
  }

  const text = await response.text();
  const data = text ? safeJson(text) : null;
  if (!response.ok) {
    if (response.status === 401) throw new SwitchTrustError("Switch Trust rejected the API key. It may be invalid, revoked or expired.", 401);
    if (response.status === 403) throw new SwitchTrustError("The API key's role can't do this. Use a key with the Editor role or higher.", 403);
    throw new SwitchTrustError(errorMessage(data) ?? `Switch Trust returned HTTP ${response.status}.`, response.status);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Errors come back as {code, message}, sometimes wrapped in {error: {...}}.
function errorMessage(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const detail = (record.error && typeof record.error === "object" ? record.error : record) as Record<string, unknown>;
  return typeof detail.message === "string" && detail.message ? detail.message : null;
}

// Finds the tenant and workspace the API key is pinned to. Also proves that the key works.
export async function resolveSwitchScope(credentials: Credentials): Promise<{ tenantId: string; workspaceId: string }> {
  const payload = await request<unknown>(credentials, "GET", "/v1/auth/tenants");
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? (["tenants", "data", "items"].map((key) => (payload as Record<string, unknown>)[key]).find(Array.isArray) ?? [payload])
      : [];

  for (const tenant of list as Record<string, unknown>[]) {
    const metadata = (tenant?.metadata ?? tenant?.Metadata ?? {}) as Record<string, unknown>;
    const tenantId = metadata.tenant_id;
    const workspaceId = metadata.active_workspace_id ?? metadata.workspace_id;
    if (typeof tenantId === "string" && typeof workspaceId === "string" && SAFE_SEGMENT.test(tenantId) && SAFE_SEGMENT.test(workspaceId)) {
      return { tenantId, workspaceId };
    }
  }
  throw new SwitchTrustError("The API key isn't linked to a Switch Trust workspace. Create the key from inside a workspace.");
}

// A connection with its decrypted key, ready for API calls.
export type SwitchClient = Credentials & { tenantId: string; workspaceId: string };

function scoped(client: SwitchClient, resource: string, rest = "") {
  return `/api/v1/${resource}/tenants/${segment(client.tenantId)}/workspaces/${segment(client.workspaceId)}${rest}`;
}

// Takes a workspace id that was already loaded through lib/workspaces.ts, so it is owned by the user.
export async function getSwitchConnection(workspaceId: string): Promise<SwitchConnection | null> {
  const row = await db.query.switchConnections.findFirst({ where: eq(switchConnections.workspaceId, workspaceId) });
  return row ?? null;
}

export function switchClientFor(connection: SwitchConnection): SwitchClient {
  return {
    instance: connection.instance,
    apiKey: decrypt(connection.apiKey),
    tenantId: connection.tenantId,
    workspaceId: connection.switchWorkspaceId,
  };
}

export async function createSwitchAgent(client: SwitchClient, name: string): Promise<string> {
  const result = await request<{ id?: string }>(client, "POST", scoped(client, "sparrow/agents"), { body: { name } });
  if (!result?.id || !SAFE_SEGMENT.test(result.id)) throw new SwitchTrustError("Switch Trust didn't return an agent id.");
  return result.id;
}

// Points Switch Trust's evaluation worker at the agent's endpoint in this app.
// Generic HTTP agents receive {"input": "..."} and answer {"output": "..."}.
export async function upsertSwitchAgentEndpoint(client: SwitchClient, switchAgentId: string, endpointUrl: string, token: string) {
  const path = scoped(client, "eval/agent-endpoints", `/${segment(switchAgentId)}`);
  const base = {
    model_type: "generic_http",
    endpoint_url: endpointUrl,
    endpoint_headers: { Authorization: `Bearer ${token}` },
    config: { input_path: "input", output_path: "output" },
  };
  try {
    await request(client, "PUT", path, { body: { ...base, endpoint_auth_type: "bearer", endpoint_credential: token } });
  } catch (error) {
    // The header alone also authenticates, for instances that name the bearer auth type differently.
    if (!(error instanceof SwitchTrustError) || (error.status !== 400 && error.status !== 422)) throw error;
    await request(client, "PUT", path, { body: { ...base, endpoint_auth_type: "none" } });
  }
}

type Page<T> = { items?: T[] | null };

export type SwitchEvaluation = { id: string; name: string; approach?: string; is_builtin?: boolean; description?: string };
export type SwitchAgentEvaluation = { id: string; evaluation_id: string; evaluation_name?: string; name?: string };
export type SwitchRun = { id: string; status?: string; summary?: Record<string, unknown> | null; error_message?: string | null };

export async function listSwitchEvaluations(client: SwitchClient) {
  const page = await request<Page<SwitchEvaluation>>(client, "GET", scoped(client, "eval/evaluations"), { query: { page_size: 100 } });
  return page?.items ?? [];
}

export async function listSwitchAgentEvaluations(client: SwitchClient, switchAgentId: string) {
  const page = await request<Page<SwitchAgentEvaluation>>(client, "GET", scoped(client, "eval/agent-evaluations"), {
    query: { agent_id: switchAgentId, page_size: 100 },
  });
  return page?.items ?? [];
}

export async function assignSwitchEvaluation(client: SwitchClient, switchAgentId: string, evaluation: SwitchEvaluation) {
  return request<SwitchAgentEvaluation>(client, "POST", scoped(client, "eval/agent-evaluations"), {
    body: { agent_id: switchAgentId, evaluation_id: evaluation.id, name: evaluation.name },
  });
}

// Starts a run now and returns its id.
export async function triggerSwitchEvaluation(client: SwitchClient, agentEvaluationId: string): Promise<string> {
  const result = await request<{ run_id?: string; id?: string }>(
    client,
    "POST",
    scoped(client, "eval/agent-evaluations", `/${segment(agentEvaluationId)}/trigger`),
  );
  const runId = result?.run_id ?? result?.id;
  if (!runId) throw new SwitchTrustError("Switch Trust didn't start the evaluation run.");
  return runId;
}

export async function getSwitchRun(client: SwitchClient, runId: string) {
  return request<SwitchRun>(client, "GET", scoped(client, "eval/evaluation-runs", `/${segment(runId)}`));
}

export type SwitchEvaluationSummary = {
  health?: { score?: number | null; previous_score?: number | null } | null;
  coverage?: { code?: string; passing?: number; at_risk?: number; not_run?: number; total?: number }[] | null;
};

export async function getSwitchEvaluationSummary(client: SwitchClient, switchAgentId: string) {
  return request<SwitchEvaluationSummary>(client, "GET", scoped(client, "eval/agent-evaluation-summary"), {
    query: { agent_id: switchAgentId },
  });
}

// Mirrors an agent's monthly budget as its Switch ROI cost cap, in US dollars.
export async function setSwitchCostCap(client: SwitchClient, switchAgentId: string, budgetCents: number) {
  await request(client, "PUT", scoped(client, "cost/agent-caps", `/${segment(switchAgentId)}`), {
    body: { monthly_cap: budgetCents / 100 },
  });
}

type CostSummary = {
  total_mtd_cost?: number;
  total_cost_cap?: number;
  spending_summary?: { healthy?: number; near_cap?: number; over_cap?: number; no_cap?: number };
};

export async function getSwitchOverview(connection: SwitchConnection): Promise<SwitchTrustOverview> {
  const overview: SwitchTrustOverview = {
    instance: connection.instance,
    tenantId: connection.tenantId,
    workspaceId: connection.switchWorkspaceId,
    connectedAt: connection.updatedAt.toISOString(),
    roi: null,
  };
  try {
    const client = switchClientFor(connection);
    const cost = await request<CostSummary>(client, "GET", scoped(client, "aispm-agents-dashboard"));
    overview.roi = {
      monthToDateCents: Math.round((cost?.total_mtd_cost ?? 0) * 100),
      capCents: Math.round((cost?.total_cost_cap ?? 0) * 100),
      healthy: cost?.spending_summary?.healthy ?? 0,
      nearCap: cost?.spending_summary?.near_cap ?? 0,
      overCap: cost?.spending_summary?.over_cap ?? 0,
      noCap: cost?.spending_summary?.no_cap ?? 0,
    };
  } catch (error) {
    // ROI is a nice-to-have on the page; a failure here must not break it.
    console.error("Switch Trust cost summary failed", error);
  }
  return overview;
}

// Switch Trust reports scores as 0–1 fractions or 0–100 percentages. Always returns 0–100, or null.
export function toPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const percent = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

// The bearer token Switch Trust sends to an agent's evaluation endpoint. Derived, so nothing extra is stored.
export function switchEvalToken(agentId: string) {
  const secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) throw new Error("TOKEN_ENCRYPTION_KEY must be set to a random string of at least 32 characters.");
  return createHmac("sha256", secret).update(`switch-eval:${agentId}`).digest("base64url");
}

export function verifySwitchEvalToken(agentId: string, token: string) {
  const expected = Buffer.from(switchEvalToken(agentId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// Switch Trust calls agents from the internet, so the app must be reachable at a public https URL.
export function switchEndpointUrl(agentId: string): { url: string } | { error: string } {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  let url: URL | null = null;
  try {
    url = base ? new URL(`/api/switch/agents/${agentId}`, base) : null;
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "https:" || ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(url.hostname)) {
    return {
      error: "Switch Trust needs to reach your agents at a public https URL. Set NEXT_PUBLIC_APP_URL to your deployed URL or a tunnel such as ngrok.",
    };
  }
  return { url: url.toString() };
}

// Marks the agents as queued and starts a Switch scan for each through Cloudhike Jobs. Paused agents are skipped.
export async function queueSwitchScans(workspaceId: string, agentIds: string[]) {
  if (agentIds.length === 0) return [];
  // switchScanStartedAt doubles as the scan's id: a newer scan of the same agent makes older jobs no-ops.
  const startedAt = new Date();
  const queued = await db
    .update(agents)
    .set({ switchScanStatus: "queued", switchScanStartedAt: startedAt, switchError: null })
    .where(and(eq(agents.workspaceId, workspaceId), inArray(agents.id, agentIds), eq(agents.enabled, true)))
    .returning({ id: agents.id });
  if (queued.length === 0) return [];

  const results = await Promise.allSettled(
    queued.map((agent) =>
      enqueueJob(SWITCH_SCAN_JOB_PATH, { phase: "start", workspaceId, agentId: agent.id, scanId: startedAt.toISOString(), attempt: 0 }),
    ),
  );
  const failures = results.flatMap((result, index) => (result.status === "rejected" ? [{ id: queued[index].id, error: result.reason }] : []));
  if (failures.length > 0) {
    console.error("Couldn't queue Switch scans", failures);
    const message = failures[0].error instanceof JobsError ? failures[0].error.message : "The scan couldn't be queued.";
    await db
      .update(agents)
      .set({ switchScanStatus: "failed", switchError: message })
      .where(and(inArray(agents.id, failures.map((failure) => failure.id)), eq(agents.switchScanStartedAt, startedAt)));
    throw new SwitchTrustError(message);
  }
  return queued.map((agent) => agent.id);
}
