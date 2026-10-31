import "server-only";

import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import { agentActivities, agents, db, taskRuns, tasks, type Agent, type Workspace } from "@/db";
import { MONTH_START, runCheckFor } from "@/lib/agent-budget";
import { AGENT_DEFAULTS } from "@/lib/agent-defaults";
import {
  AGENT_ROLES,
  AGENT_WORKING_WINDOW_MS,
  DEFAULT_AGENT_SKILLS,
  HIGH_IMPACT_TOOLS,
  type AgentActivityItem,
  type AgentRole,
  type AgentStatus,
  type AgentSummary,
  type TrustFinding,
} from "@/lib/ai-team";
import { taskKeyPrefix } from "@/lib/board";
import type { OfficeAgent } from "@/lib/office";
import { STAGE_AGENT } from "@/lib/workflow";

// Every query takes a workspace that was already loaded through lib/workspaces.ts, so it is owned by the user.
export async function listAgentSummaries(workspace: Pick<Workspace, "id">): Promise<AgentSummary[]> {
  let rows = await db.query.agents.findMany({ where: eq(agents.workspaceId, workspace.id) });
  if (rows.length < AGENT_ROLES.length) {
    await createDefaultAgents(workspace.id, rows);
    rows = await db.query.agents.findMany({ where: eq(agents.workspaceId, workspace.id) });
  }

  const [stats, latestWork] = await Promise.all([
    db
      .select({
        agentId: agentActivities.agentId,
        spent: sql<number>`coalesce(sum(${agentActivities.costCents}) filter (where ${agentActivities.createdAt} >= ${MONTH_START}), 0)::int`,
        runs: sql<number>`(count(*) filter (where ${agentActivities.costCents} > 0 and ${agentActivities.createdAt} >= ${MONTH_START}))::int`,
        lastActiveAt: max(agentActivities.createdAt),
      })
      .from(agentActivities)
      .where(eq(agentActivities.workspaceId, workspace.id))
      .groupBy(agentActivities.agentId),
    db
      .selectDistinctOn([agentActivities.agentId], {
        agentId: agentActivities.agentId,
        kind: agentActivities.kind,
        createdAt: agentActivities.createdAt,
      })
      .from(agentActivities)
      .where(
        and(
          eq(agentActivities.workspaceId, workspace.id),
          inArray(agentActivities.kind, ["task_started", "task_completed", "error"]),
        ),
      )
      .orderBy(agentActivities.agentId, desc(agentActivities.createdAt)),
  ]);
  const statsById = new Map(stats.map((row) => [row.agentId, row]));
  const workById = new Map(latestWork.map((row) => [row.agentId, row]));

  return rows
    .sort((a, b) => AGENT_ROLES.indexOf(a.role) - AGENT_ROLES.indexOf(b.role))
    .map((agent) => {
      const stat = statsById.get(agent.id);
      const work = workById.get(agent.id);
      const spentCents = stat?.spent ?? 0;
      const working = work?.kind === "task_started" && Date.now() - work.createdAt.getTime() < AGENT_WORKING_WINDOW_MS;
      // Same rule the run gate applies, so the card never shows an agent as available when runs would be refused.
      const check = runCheckFor(agent, spentCents);
      const status: AgentStatus = check.ok
        ? working
          ? "working"
          : "idle"
        : check.reason === "paused"
          ? "paused"
          : "over_budget";

      return {
        id: agent.id,
        role: agent.role,
        name: agent.name,
        description: agent.description,
        instructions: agent.instructions,
        skills: agent.skills,
        budgetCents: agent.budgetCents,
        maxTurns: agent.maxTurns,
        enabled: agent.enabled,
        status,
        switch: {
          status: agent.switchScanStatus,
          score: agent.switchScore,
          report: agent.switchReport,
          scannedAt: agent.switchScannedAt?.toISOString() ?? null,
          error: agent.switchError,
          stale: !!agent.switchScannedAt && agent.updatedAt > agent.switchScannedAt,
        },
        spentCents,
        runs: stat?.runs ?? 0,
        lastActiveAt: stat?.lastActiveAt?.toISOString() ?? null,
      };
    });
}

// The team at their desks: each agent's status and the stage of a running task it owns.
export async function listOfficeAgents(workspace: Pick<Workspace, "id" | "name">): Promise<OfficeAgent[]> {
  const [summaries, running, latest] = await Promise.all([
    listAgentSummaries(workspace),
    db
      .select({
        stage: taskRuns.stage,
        stageTurns: taskRuns.stageTurns,
        round: taskRuns.round,
        branch: taskRuns.branch,
        createdAt: taskRuns.createdAt,
        taskNumber: tasks.number,
        taskTitle: tasks.title,
      })
      .from(taskRuns)
      .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
      .where(and(eq(taskRuns.workspaceId, workspace.id), eq(taskRuns.status, "running")))
      .orderBy(desc(taskRuns.createdAt)),
    db
      .selectDistinctOn([agentActivities.agentId], {
        agentId: agentActivities.agentId,
        title: agentActivities.title,
        createdAt: agentActivities.createdAt,
      })
      .from(agentActivities)
      .where(eq(agentActivities.workspaceId, workspace.id))
      .orderBy(agentActivities.agentId, desc(agentActivities.createdAt)),
  ]);
  const prefix = taskKeyPrefix(workspace.name);
  const latestById = new Map(latest.map((row) => [row.agentId, row]));

  return summaries.map((agent) => {
    const run = running.find((row) => STAGE_AGENT[row.stage] === agent.role);
    const last = latestById.get(agent.id);
    // A running stage means the agent is typing right now, unless it's paused or out of budget.
    const status = run && agent.status === "idle" ? "working" : agent.status;

    return {
      id: agent.id,
      role: agent.role,
      name: agent.name,
      status,
      task: run
        ? {
            key: `${prefix}-${run.taskNumber}`,
            title: run.taskTitle,
            stage: run.stage,
            turns: run.stageTurns,
            maxTurns: agent.maxTurns,
            round: run.round,
            branch: run.branch,
            startedAt: run.createdAt.toISOString(),
          }
        : null,
      lastActivity: last ? { title: last.title, createdAt: last.createdAt.toISOString() } : null,
      spentCents: agent.spentCents,
      budgetCents: agent.budgetCents,
    };
  });
}

export async function getAgent(workspaceId: string, id: string): Promise<Agent | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const row = await db.query.agents.findFirst({
    where: and(eq(agents.id, id), eq(agents.workspaceId, workspaceId)),
  });
  return row ?? null;
}

// The workspace's agent for a role, seeding the default team first if it's missing.
export async function getAgentByRole(workspaceId: string, role: AgentRole): Promise<Agent | null> {
  const find = () => db.query.agents.findFirst({ where: and(eq(agents.workspaceId, workspaceId), eq(agents.role, role)) });
  const agent = await find();
  if (agent) return agent;
  await createDefaultAgents(
    workspaceId,
    await db.query.agents.findMany({ where: eq(agents.workspaceId, workspaceId), columns: { role: true } }),
  );
  return (await find()) ?? null;
}

export async function listAgentActivity(workspaceId: string, agentId: string, limit = 50): Promise<AgentActivityItem[]> {
  const rows = await db.query.agentActivities.findMany({
    where: and(eq(agentActivities.workspaceId, workspaceId), eq(agentActivities.agentId, agentId)),
    orderBy: desc(agentActivities.createdAt),
    limit,
  });
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    detail: row.detail,
    costCents: row.costCents,
    createdAt: row.createdAt.toISOString(),
  }));
}

// Seeds the roles a workspace is missing. Safe to run concurrently thanks to the unique (workspace, role) index.
async function createDefaultAgents(workspaceId: string, existing: Pick<Agent, "role">[]) {
  const missing = AGENT_ROLES.filter((role) => !existing.some((agent) => agent.role === role));
  const values = missing.map((role) => {
    const defaults = AGENT_DEFAULTS[role];
    const scan = runTrustChecks({ ...defaults, role });
    return {
      workspaceId,
      role,
      ...defaults,
      trustScore: scan.score,
      trustFindings: scan.findings,
      trustScannedAt: new Date(),
    };
  });

  const created = await db
    .insert(agents)
    .values(values)
    .onConflictDoNothing({ target: [agents.workspaceId, agents.role] })
    .returning({ id: agents.id, name: agents.name });
  if (created.length === 0) return;

  await db.insert(agentActivities).values(
    created.map((agent) => ({
      workspaceId,
      agentId: agent.id,
      kind: "joined" as const,
      title: `${agent.name} joined the team`,
      detail: "Configured with the default instructions, skills and budget.",
    })),
  );
}

type ScanInput = Pick<Agent, "role" | "instructions" | "skills" | "budgetCents" | "description">;

// DevCrew's built-in checks. Each passes for full points, warns for half or fails for none.
function runTrustChecks(agent: ScanInput): { score: number; findings: TrustFinding[] } {
  const text = agent.instructions;
  const has = (pattern: RegExp) => pattern.test(text);
  const defaults = DEFAULT_AGENT_SKILLS[agent.role];
  const matchingSkills = defaults.filter((skill) => agent.skills.includes(skill)).length;

  const checks: (TrustFinding & { weight: number })[] = [
    {
      weight: 20,
      title: "Clear role and workflow",
      ...(text.length >= 400 && has(/\brole\b/i) && has(/workflow|steps|^\s*1\./im)
        ? { level: "pass", detail: "The instructions define the agent's role and the steps it follows." }
        : text.length >= 200
          ? { level: "warn", detail: "Add a role and a step-by-step workflow so the agent behaves predictably." }
          : { level: "fail", detail: "The instructions are too short to steer an autonomous agent." }),
    },
    {
      weight: 20,
      title: "Prompt-injection guardrail",
      ...(has(/untrusted|as data|prompt[- ]injection|ignore any (request|instruction)/i)
        ? { level: "pass", detail: "Repository content and tool output are treated as data, not instructions." }
        : { level: "fail", detail: "Tell the agent to treat issues, code and web pages as untrusted data." }),
    },
    {
      weight: 15,
      title: "Secrets protected",
      ...(has(/secret|credential|\.env|token/i)
        ? { level: "pass", detail: "The agent is told never to expose secrets or tokens." }
        : { level: "fail", detail: "Forbid printing or committing secrets, tokens and .env values." }),
    },
    {
      weight: 20,
      title: "Approval for high-impact tools",
      ...(has(/approv|ask (a human|for permission|before)/i)
        ? { level: "pass", detail: `${HIGH_IMPACT_TOOLS.length} high-impact tools are gated by human approval.` }
        : { level: "warn", detail: "Shell, apply patch and computer use are enabled without an approval rule." }),
    },
    {
      weight: 10,
      title: "Budget cap",
      ...(agent.budgetCents <= 100_000
        ? { level: "pass", detail: "The monthly budget limits how much a runaway loop can spend." }
        : { level: "warn", detail: "The monthly budget is above $1,000. Consider a lower cap." }),
    },
    {
      weight: 15,
      title: "Skills match the role",
      ...(matchingSkills * 2 >= defaults.length
        ? { level: "pass", detail: "The attached skills fit what this agent is responsible for." }
        : matchingSkills > 0
          ? { level: "warn", detail: "Several of this role's core skills are detached." }
          : { level: "fail", detail: "None of this role's core skills are attached." }),
    },
  ];

  const score = checks.reduce((sum, check) => sum + (check.level === "pass" ? check.weight : check.level === "warn" ? check.weight / 2 : 0), 0);
  return {
    score: Math.round(score),
    findings: checks.map(({ level, title, detail }) => ({ level, title, detail, source: "check" })),
  };
}
