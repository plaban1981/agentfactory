import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, db, workspaces } from "@/db";
import { AgentRunBlockedError, assertAgentCanRun, recordAgentSpend } from "@/lib/agent-budget";
import { AGENT_ROLE_LABELS, type SwitchEvaluationResult, type SwitchReport } from "@/lib/ai-team";
import { enqueueJob, JobsError } from "@/lib/jobs";
import { isOpenAIConfigured } from "@/lib/openai";
import {
  assignSwitchEvaluation,
  createSwitchAgent,
  getSwitchConnection,
  getSwitchEvaluationSummary,
  getSwitchRun,
  listSwitchAgentEvaluations,
  listSwitchEvaluations,
  setSwitchCostCap,
  SWITCH_SCAN_JOB_PATH,
  switchClientFor,
  switchEndpointUrl,
  switchEvalToken,
  SwitchTrustError,
  toPercent,
  triggerSwitchEvaluation,
  upsertSwitchAgentEndpoint,
  type SwitchEvaluation,
  type SwitchRun,
} from "@/lib/switch-trust";

// Each scan runs one built-in evaluation: quick probes first, then the best match for these risks.
const PREFERRED_EVALUATIONS = /inject|jailbreak|secret|credential|leak|pii|exfiltrat|prompt|system|harm|toxic/i;
// Each job polls the run in-process so a quick evaluation finishes in seconds, then hands off to a fresh job.
const POLL_INTERVAL_MS = 3_000;
const POLL_WINDOW_MS = 45_000;
const NEXT_CHECK_DELAY_SECONDS = 5;
const SCAN_TIMEOUT_MS = 20 * 60_000;
// Switch Trust creates a triggered run asynchronously, so it can answer 404 for a short while.
const RUN_LOOKUP_GRACE_MS = 2 * 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_SECONDS = 30;
const FINISHED_STATUSES = new Set(["finished", "done", "completed", "succeeded", "error", "failed", "cancelled"]);

type QueuedRun = { runId: string; name: string };

// A scan runs as a chain of Cloudhike jobs: one "start", then "check" jobs that requeue themselves until the run finishes.
// `scanId` is the agent's switchScanStartedAt, so a job from an older or superseded scan does nothing.
export type SwitchScanJob = { workspaceId: string; agentId: string; scanId: string; attempt: number } & (
  | { phase: "start" }
  | { phase: "check"; switchAgentId: string; runs: QueuedRun[] }
);

// Errors that a retry won't fix.
class ScanError extends Error {}

export async function runSwitchScanJob(job: SwitchScanJob) {
  try {
    if (job.phase === "start") await startScan(job);
    else await checkScan(job);
  } catch (error) {
    await handleFailure(job, error);
  }
}

async function startScan(job: SwitchScanJob & { phase: "start" }) {
  // Claiming the queued scan makes a duplicate delivery of this job a no-op, and opens the evaluation endpoint.
  const [claimed] = await db
    .update(agents)
    .set({ switchScanStatus: "running" })
    .where(and(scanMatches(job), eq(agents.switchScanStatus, "queued")))
    .returning({ id: agents.id });
  if (!claimed) return;

  const started = await startEvaluations(job.workspaceId, job.agentId);
  await checkScan({ ...job, phase: "check", attempt: 0, ...started });
}

async function checkScan(job: SwitchScanJob & { phase: "check" }) {
  const windowEnds = Date.now() + POLL_WINDOW_MS;
  const scanEnds = new Date(job.scanId).getTime() + SCAN_TIMEOUT_MS;
  for (;;) {
    const agent = await db.query.agents.findFirst({ where: and(scanMatches(job), eq(agents.switchScanStatus, "running")) });
    if (!agent) return;

    const runs = await checkRuns(job);
    if (runs.every((run) => FINISHED_STATUSES.has(run.status)) || Date.now() >= scanEnds) {
      await saveReport(job, runs);
      return;
    }
    if (Date.now() + POLL_INTERVAL_MS >= windowEnds) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  await enqueueCheck({ ...job, attempt: 0 });
}

function enqueueCheck(job: SwitchScanJob & { phase: "check" }, delaySeconds = NEXT_CHECK_DELAY_SECONDS) {
  return enqueueJob(SWITCH_SCAN_JOB_PATH, job, { delaySeconds });
}

// Transient failures are retried as a fresh job; anything else, or the last attempt, ends the scan with the error.
async function handleFailure(job: SwitchScanJob, error: unknown) {
  const transient = !(error instanceof ScanError || error instanceof JobsError || isSwitchClientError(error));
  if (transient && job.attempt + 1 < MAX_ATTEMPTS) {
    console.error("Switch scan step failed, retrying", error);
    try {
      if (job.phase === "start") {
        await db.update(agents).set({ switchScanStatus: "queued" }).where(and(scanMatches(job), eq(agents.switchScanStatus, "running")));
        await enqueueJob(SWITCH_SCAN_JOB_PATH, { ...job, attempt: job.attempt + 1 }, { delaySeconds: RETRY_DELAY_SECONDS });
      } else {
        await enqueueCheck({ ...job, attempt: job.attempt + 1 }, RETRY_DELAY_SECONDS);
      }
      return;
    } catch (retryError) {
      error = retryError;
    }
  }
  console.error("Switch scan failed", error);
  await finishScan(job, { error: error instanceof Error ? error.message : "The scan failed." });
}

async function startEvaluations(workspaceId: string, agentId: string) {
  const [connection, agent, workspace] = await Promise.all([
    getSwitchConnection(workspaceId),
    db.query.agents.findFirst({ where: and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)) }),
    db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) }),
  ]);
  if (!connection) throw new ScanError("Switch Trust isn't connected to this workspace.");
  if (!agent || !workspace) throw new ScanError("This agent no longer exists.");
  if (!isOpenAIConfigured()) throw new ScanError("Add OPENAI_API_KEY so Switch Trust can talk to your agents.");
  const endpoint = switchEndpointUrl(agent.id);
  if ("error" in endpoint) throw new ScanError(endpoint.error);
  try {
    await assertAgentCanRun(workspaceId, agentId);
  } catch (error) {
    if (error instanceof AgentRunBlockedError) throw new ScanError(error.message);
    throw error;
  }

  const client = switchClientFor(connection);
  let switchAgentId = agent.switchAgentId;
  if (!switchAgentId) {
    // The id suffix keeps names unique when several workspaces share one Switch Trust workspace.
    switchAgentId = await createSwitchAgent(
      client,
      `DevCrew ${AGENT_ROLE_LABELS[agent.role]} · ${workspace.repoFullName} · ${agent.id.slice(0, 8)}`,
    );
    await db.update(agents).set({ switchAgentId }).where(eq(agents.id, agent.id));
    // Switch ROI tracks spend against the same monthly budget DevCrew enforces.
    await setSwitchCostCap(client, switchAgentId, agent.budgetCents).catch((error) => console.error("Switch cost cap failed", error));
  }
  await upsertSwitchAgentEndpoint(client, switchAgentId, endpoint.url, switchEvalToken(agent.id));

  const [catalog, assigned] = await Promise.all([listSwitchEvaluations(client), listSwitchAgentEvaluations(client, switchAgentId)]);
  const pick = pickEvaluation(catalog);
  if (!pick) throw new ScanError("Your Switch Trust workspace has no evaluations to run.");
  const item = assigned.find((entry) => entry.evaluation_id === pick.id) ?? (await assignSwitchEvaluation(client, switchAgentId, pick));

  const runs = [{ runId: await triggerSwitchEvaluation(client, item.id), name: item.evaluation_name || item.name || pick.name }];
  return { switchAgentId, runs };
}

function pickEvaluation(catalog: SwitchEvaluation[]) {
  const builtIn = catalog.filter((evaluation) => evaluation.is_builtin !== false);
  const rank = (evaluation: SwitchEvaluation) =>
    Number(evaluation.approach === "probe") * 2 + Number(PREFERRED_EVALUATIONS.test(`${evaluation.name} ${evaluation.description ?? ""}`));
  return [...builtIn].sort((a, b) => rank(b) - rank(a))[0];
}

async function checkRuns(job: SwitchScanJob & { phase: "check" }): Promise<SwitchEvaluationResult[]> {
  const connection = await getSwitchConnection(job.workspaceId);
  if (!connection) throw new ScanError("Switch Trust was disconnected during the scan.");
  const client = switchClientFor(connection);
  return Promise.all(
    job.runs.map(async ({ runId, name }) => {
      let run: SwitchRun;
      try {
        run = await getSwitchRun(client, runId);
      } catch (error) {
        const justStarted = Date.now() < new Date(job.scanId).getTime() + RUN_LOOKUP_GRACE_MS;
        if (error instanceof SwitchTrustError && error.status === 404 && justStarted) return { name, status: "queued", score: null };
        throw error;
      }
      const summary = run.summary ?? {};
      const achieved = typeof summary.achieved_score === "number" && typeof summary.max_score === "number" && summary.max_score > 0
        ? summary.achieved_score / summary.max_score
        : null;
      return { name, status: (run.status ?? "queued").toLowerCase(), score: toPercent(summary.score ?? achieved) };
    }),
  );
}

async function saveReport(job: SwitchScanJob & { phase: "check" }, runs: SwitchEvaluationResult[]) {
  const connection = await getSwitchConnection(job.workspaceId);
  if (!connection) throw new ScanError("Switch Trust was disconnected during the scan.");
  const summary = await getSwitchEvaluationSummary(switchClientFor(connection), job.switchAgentId);

  const scored = runs.filter((run) => run.score !== null);
  const score =
    toPercent(summary?.health?.score) ??
    (scored.length ? Math.round(scored.reduce((sum, run) => sum + (run.score ?? 0), 0) / scored.length) : null);
  const unfinished = runs.filter((run) => !FINISHED_STATUSES.has(run.status)).length;
  const failed = runs.filter((run) => run.status === "error" || run.status === "failed").length;

  let error: string | null = null;
  if (score === null) error = "Switch Trust couldn't score this agent. Open the agent in Switch Trust to see why the runs failed.";
  else if (unfinished > 0) error = `${unfinished} evaluation${unfinished === 1 ? " was" : "s were"} still running when the scan stopped waiting.`;
  else if (failed > 0) error = `${failed} evaluation${failed === 1 ? "" : "s"} couldn't finish. The score covers the rest.`;

  await finishScan(job, {
    score,
    error,
    report: {
      evaluations: runs,
      coverage: (summary?.coverage ?? []).map((entry) => ({
        code: entry.code ?? "",
        passing: entry.passing ?? 0,
        atRisk: entry.at_risk ?? 0,
        notRun: entry.not_run ?? 0,
        total: entry.total ?? 0,
      })),
      previousScore: toPercent(summary?.health?.previous_score),
      costCents: 0,
    },
  });
}

// Stores the outcome and records the scan's model spend through the budget ledger, once per scan.
async function finishScan(job: SwitchScanJob, outcome: { score?: number | null; report?: SwitchReport; error: string | null }) {
  const agent = await db.query.agents.findFirst({ where: scanMatches(job) });
  if (!agent) return;

  const pending = agent.switchScanCostCents;
  const costCents = Math.ceil(pending);
  const scored = outcome.score !== undefined && outcome.score !== null;

  // Only one job can move the scan out of queued or running, so a duplicate delivery can't record the spend twice.
  const [finished] = await db
    .update(agents)
    .set({
      switchScanStatus: scored ? "done" : "failed",
      switchError: outcome.error,
      switchScanCostCents: sql`greatest(0, ${agents.switchScanCostCents} - ${pending})`,
      // A failed scan keeps the last good score and report.
      ...(scored && {
        switchScore: outcome.score,
        switchReport: { ...outcome.report!, costCents },
        switchScannedAt: new Date(),
      }),
    })
    .where(and(scanMatches(job), inArray(agents.switchScanStatus, ["queued", "running"])))
    .returning({ id: agents.id });
  if (!finished) return;

  await recordAgentSpend({
    workspaceId: job.workspaceId,
    agentId: job.agentId,
    kind: "scan",
    title: scored ? `Switch Trust scored ${outcome.score}/100` : "Switch Trust scan failed",
    detail: outcome.error ?? `${outcome.report?.evaluations.length ?? 0} red-team evaluations by Switch Trust.`,
    costCents,
  });
}

function scanMatches(job: SwitchScanJob) {
  return and(
    eq(agents.id, job.agentId),
    eq(agents.workspaceId, job.workspaceId),
    eq(agents.switchScanStartedAt, new Date(job.scanId)),
  );
}

// Client errors (bad key, missing permission, bad request) won't fix themselves, so they aren't retried.
function isSwitchClientError(error: unknown) {
  return error instanceof SwitchTrustError && !!error.status && error.status >= 400 && error.status < 500;
}
