import "server-only";

import { desc, eq } from "drizzle-orm";
import { agentActivities, agents, db, tasks, type Workspace } from "@/db";
import type { AgentActivityKind, AgentRole } from "@/lib/ai-team";
import { taskKeyPrefix } from "@/lib/board";

export type WorkspaceActivityKind = AgentActivityKind | "task_created";

// One event in a workspace's feed: something an agent did, or a task added to the board.
export type WorkspaceActivityItem = {
  id: string;
  kind: WorkspaceActivityKind;
  actor: string;
  // Set when an agent did it
  role: AgentRole | null;
  title: string;
  detail: string | null;
  costCents: number;
  createdAt: string;
};

// The workspace's newest events, merged from the agent log and the board. Takes a workspace loaded through lib/workspaces.ts.
export async function listWorkspaceActivity(
  workspace: Pick<Workspace, "id" | "name">,
  limit = 50,
): Promise<WorkspaceActivityItem[]> {
  const [agentRows, taskRows] = await Promise.all([
    db
      .select({
        id: agentActivities.id,
        kind: agentActivities.kind,
        title: agentActivities.title,
        detail: agentActivities.detail,
        costCents: agentActivities.costCents,
        createdAt: agentActivities.createdAt,
        agentName: agents.name,
        role: agents.role,
      })
      .from(agentActivities)
      .innerJoin(agents, eq(agents.id, agentActivities.agentId))
      .where(eq(agentActivities.workspaceId, workspace.id))
      .orderBy(desc(agentActivities.createdAt))
      .limit(limit),
    db.query.tasks.findMany({
      where: eq(tasks.workspaceId, workspace.id),
      columns: { id: true, number: true, title: true, githubIssueNumber: true, createdAt: true },
      orderBy: desc(tasks.createdAt),
      limit,
    }),
  ]);

  const prefix = taskKeyPrefix(workspace.name);
  const items: WorkspaceActivityItem[] = [
    ...agentRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      actor: row.agentName,
      role: row.role,
      title: row.title,
      detail: row.detail,
      costCents: row.costCents,
      createdAt: row.createdAt.toISOString(),
    })),
    ...taskRows.map((task) => ({
      id: `task-${task.id}`,
      kind: "task_created" as const,
      actor: task.githubIssueNumber !== null ? "GitHub" : "You",
      role: null,
      title: `Created ${prefix}-${task.number} ${task.title}`,
      detail: task.githubIssueNumber !== null ? `Imported from issue #${task.githubIssueNumber}.` : null,
      costCents: 0,
      createdAt: task.createdAt.toISOString(),
    })),
  ];

  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}
