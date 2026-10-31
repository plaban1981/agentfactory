import "server-only";

import { and, asc, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db, pullRequests, taskRuns, tasks, type Workspace } from "@/db";
import { taskKeyPrefix, type TaskPriority, type TaskStatus } from "@/lib/board";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_STATUSES: TaskStatus[] = ["in_development", "in_review", "testing"];

export type OverviewStats = {
  openTasks: number;
  createdThisWeek: number;
  inProgress: number;
  runningRuns: number;
  openPullRequests: number;
  blockedPullRequests: number;
};

export type UpcomingTask = {
  id: string;
  key: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: string | null;
  // YYYY-MM-DD
  dueDate: string | null;
};

// Every query takes a workspace that was already loaded through lib/workspaces.ts, so it is owned by the user.
export async function getOverviewStats(workspace: Pick<Workspace, "id">): Promise<OverviewStats> {
  const weekAgo = new Date(Date.now() - WEEK_MS);
  const [openTasks, createdThisWeek, inProgress, runningRuns, openPullRequests, blockedPullRequests] = await Promise.all([
    db.$count(tasks, and(eq(tasks.workspaceId, workspace.id), ne(tasks.status, "done"))),
    db.$count(tasks, and(eq(tasks.workspaceId, workspace.id), gte(tasks.createdAt, weekAgo))),
    db.$count(tasks, and(eq(tasks.workspaceId, workspace.id), inArray(tasks.status, ACTIVE_STATUSES))),
    db.$count(taskRuns, and(eq(taskRuns.workspaceId, workspace.id), eq(taskRuns.status, "running"))),
    db.$count(pullRequests, and(eq(pullRequests.workspaceId, workspace.id), eq(pullRequests.state, "open"))),
    db.$count(
      pullRequests,
      and(eq(pullRequests.workspaceId, workspace.id), eq(pullRequests.state, "open"), isNotNull(pullRequests.mergeBlock)),
    ),
  ]);
  return { openTasks, createdThisWeek, inProgress, runningRuns, openPullRequests, blockedPullRequests };
}

// Unfinished tasks, soonest due first, then by priority.
export async function listUpcomingTasks(workspace: Pick<Workspace, "id" | "name">, limit = 5): Promise<UpcomingTask[]> {
  const rows = await db.query.tasks.findMany({
    where: and(eq(tasks.workspaceId, workspace.id), ne(tasks.status, "done")),
    columns: { id: true, number: true, title: true, status: true, priority: true, assignee: true, dueDate: true },
    orderBy: [
      sql`${tasks.dueDate} asc nulls last`,
      sql`case ${tasks.priority} when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`,
      asc(tasks.position),
    ],
    limit,
  });
  const prefix = taskKeyPrefix(workspace.name);
  return rows.map(({ number, ...task }) => ({ ...task, key: `${prefix}-${number}` }));
}
