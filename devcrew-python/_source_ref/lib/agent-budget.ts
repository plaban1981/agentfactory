import "server-only";

import { and, eq, gte, sql } from "drizzle-orm";
import { agentActivities, agents, db, type Agent, type NewAgentActivity } from "@/db";
import { BUDGET_WARNING_RATIO, MIN_BALANCE_TO_RUN_CENTS } from "@/lib/ai-team";
import { formatCents } from "@/lib/format";

// Budget enforcement for agent runs. Whatever runs an agent must:
//   1. call assertAgentCanRun() before the run and before every model or tool call, and
//   2. record every cost with recordAgentSpend(), never by inserting costed activities directly.
// A run can overshoot its budget by at most the one step that was already in flight.

export const MONTH_START = sql`date_trunc('month', now())`;

type Executor = Pick<typeof db, "select">;

export type RunBlockReason = "not_found" | "paused" | "budget_exhausted";

export class AgentRunBlockedError extends Error {
  constructor(
    readonly reason: RunBlockReason,
    message: string,
  ) {
    super(message);
    this.name = "AgentRunBlockedError";
  }
}

export async function getMonthlySpend(agentId: string, executor: Executor = db): Promise<number> {
  const [row] = await executor
    .select({ spent: sql<number>`coalesce(sum(${agentActivities.costCents}), 0)::int` })
    .from(agentActivities)
    .where(and(eq(agentActivities.agentId, agentId), gte(agentActivities.createdAt, MONTH_START)));
  return row?.spent ?? 0;
}

export type RunCheck =
  | { ok: true; spentCents: number; budgetCents: number; remainingCents: number }
  | { ok: false; reason: RunBlockReason; message: string };

export function runCheckFor(agent: Pick<Agent, "name" | "enabled" | "budgetCents">, spentCents: number): RunCheck {
  if (!agent.enabled) return { ok: false, reason: "paused", message: `${agent.name} is paused.` };
  const remainingCents = agent.budgetCents - spentCents;
  if (remainingCents < MIN_BALANCE_TO_RUN_CENTS) {
    return {
      ok: false,
      reason: "budget_exhausted",
      message: `${agent.name} has used ${formatCents(spentCents)} of its ${formatCents(agent.budgetCents, { whole: true })} monthly budget.`,
    };
  }
  return { ok: true, spentCents, budgetCents: agent.budgetCents, remainingCents };
}

export async function checkAgentCanRun(workspaceId: string, agentId: string): Promise<RunCheck> {
  const agent = await db.query.agents.findFirst({
    where: and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)),
  });
  if (!agent) return { ok: false, reason: "not_found", message: "This agent no longer exists." };
  return runCheckFor(agent, await getMonthlySpend(agent.id));
}

// Throws AgentRunBlockedError when the agent is paused or out of budget; returns what it has left otherwise.
export async function assertAgentCanRun(workspaceId: string, agentId: string) {
  const check = await checkAgentCanRun(workspaceId, agentId);
  if (!check.ok) throw new AgentRunBlockedError(check.reason, check.message);
  return check;
}

export type SpendInput = Pick<NewAgentActivity, "kind" | "title" | "detail"> & {
  workspaceId: string;
  agentId: string;
  costCents: number;
};

// Records a step's cost and logs the warning and limit notices when the spend crosses them.
// The agent row is locked so concurrent runs can't both slip past a threshold unnoticed.
export async function recordAgentSpend(input: SpendInput) {
  if (!Number.isInteger(input.costCents) || input.costCents < 0) throw new Error("costCents must be a non-negative integer");

  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.workspaceId, input.workspaceId)))
      .for("update");
    if (!agent) throw new AgentRunBlockedError("not_found", "This agent no longer exists.");

    const before = await getMonthlySpend(agent.id, tx);
    const after = before + input.costCents;
    const warnAt = Math.round(agent.budgetCents * BUDGET_WARNING_RATIO);
    const base = { workspaceId: agent.workspaceId, agentId: agent.id };

    // Costs already incurred are always recorded, even when they push the agent over its budget.
    await tx.insert(agentActivities).values({ ...base, kind: input.kind, title: input.title, detail: input.detail, costCents: input.costCents });

    if (before < agent.budgetCents && after >= agent.budgetCents) {
      await tx.insert(agentActivities).values({
        ...base,
        kind: "budget_reached",
        title: "Monthly budget reached",
        detail: `Spent ${formatCents(after)} of ${formatCents(agent.budgetCents, { whole: true })}. New runs are blocked until next month or until the budget is raised.`,
      });
    } else if (before < warnAt && after >= warnAt && after < agent.budgetCents) {
      await tx.insert(agentActivities).values({
        ...base,
        kind: "budget_warning",
        title: `${Math.round(BUDGET_WARNING_RATIO * 100)}% of monthly budget used`,
        detail: `Spent ${formatCents(after)} of ${formatCents(agent.budgetCents, { whole: true })}.`,
      });
    }

    return runCheckFor(agent, after);
  });
}
