import "server-only";

import { and, asc, desc, eq, max, min } from "drizzle-orm";
import { db, pullRequests, taskRuns, tasks, type NewTask, type PullRequest, type Task, type TaskRun, type Workspace } from "@/db";
import { AGENT_WORKING_WINDOW_MS } from "@/lib/ai-team";
import { taskKeyPrefix, type AgentRunStatus, type BoardTask, type TaskStatus } from "@/lib/board";

// Gap between neighbouring cards' positions, so a new card can go above the first one.
export const POSITION_STEP = 1024;

// Every query takes a workspace that was already loaded through lib/workspaces.ts, so it is owned by the user.
export async function listBoardTasks(workspace: Pick<Workspace, "id" | "name">): Promise<BoardTask[]> {
  const [rows, runs, pulls] = await Promise.all([
    db.query.tasks.findMany({
      where: eq(tasks.workspaceId, workspace.id),
      orderBy: [asc(tasks.position), desc(tasks.createdAt)],
    }),
    db
      .selectDistinctOn([taskRuns.taskId])
      .from(taskRuns)
      .where(eq(taskRuns.workspaceId, workspace.id))
      .orderBy(taskRuns.taskId, desc(taskRuns.createdAt)),
    db
      .selectDistinctOn([pullRequests.taskId])
      .from(pullRequests)
      .where(eq(pullRequests.workspaceId, workspace.id))
      .orderBy(pullRequests.taskId, desc(pullRequests.createdAt)),
  ]);
  const runByTask = new Map(runs.map((run) => [run.taskId, run]));
  const pullByTask = new Map(pulls.map((pull) => [pull.taskId, pull]));
  const prefix = taskKeyPrefix(workspace.name);
  return rows.map((task) => toBoardTask(task, prefix, runByTask.get(task.id), pullByTask.get(task.id)));
}

// The position that puts a card on top of a column.
export async function topPosition(workspaceId: string, status: TaskStatus, executor: Pick<typeof db, "select"> = db) {
  const [{ top }] = await executor
    .select({ top: min(tasks.position) })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, status)));
  return (top ?? 0) - POSITION_STEP;
}

export async function getTask(workspaceId: string, id: string): Promise<Task | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const row = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId)),
  });
  return row ?? null;
}

export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === "23505") return true;
  // Drizzle wraps driver errors and keeps the original as `cause`.
  return "cause" in error && isUniqueViolation(error.cause);
}

// Inserts tasks at the top of their columns, numbering them after the workspace's newest task.
// Rows for a GitHub issue that is already on the board are skipped, so overlapping syncs are safe.
// Returns the ids of the tasks it inserted.
export async function insertTasks(workspaceId: string, rows: Omit<NewTask, "workspaceId" | "number" | "position">[]) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const [{ last }] = await tx
          .select({ last: max(tasks.number) })
          .from(tasks)
          .where(eq(tasks.workspaceId, workspaceId));
        const tops = await tx
          .select({ status: tasks.status, top: min(tasks.position) })
          .from(tasks)
          .where(eq(tasks.workspaceId, workspaceId))
          .groupBy(tasks.status);
        const nextTop = new Map(tops.map((row) => [row.status, (row.top ?? 0) - POSITION_STEP]));

        // Insert in reverse so the first row ends up on top of its column.
        const values = rows.map((row, i) => ({ ...row, workspaceId, number: (last ?? 0) + i + 1 })).reverse();
        const ids: string[] = [];
        for (const value of values) {
          const status = value.status ?? "todo";
          const position = nextTop.get(status) ?? 0;
          nextTop.set(status, position - POSITION_STEP);
          const inserted = await tx
            .insert(tasks)
            .values({ ...value, position })
            .onConflictDoNothing({ target: [tasks.workspaceId, tasks.githubIssueId] })
            .returning({ id: tasks.id });
          ids.push(...inserted.map((row) => row.id));
        }
        return ids.reverse();
      });
    } catch (error) {
      // Two creates raced for the same number; try again with a fresh one.
      if (attempt < 2 && isUniqueViolation(error)) continue;
      throw error;
    }
  }
}

// A run that has been going longer than an agent's working window is treated as abandoned, so it can be started again.
export function runStatus(task: Pick<Task, "agentRunStatus" | "agentRunStartedAt">): AgentRunStatus | null {
  if (task.agentRunStatus !== "running") return task.agentRunStatus;
  const startedAt = task.agentRunStartedAt?.getTime() ?? 0;
  return Date.now() - startedAt < AGENT_WORKING_WINDOW_MS ? "running" : null;
}

function toBoardTask(task: Task, prefix: string, run?: TaskRun, pull?: PullRequest): BoardTask {
  return {
    id: task.id,
    key: `${prefix}-${task.number}`,
    type: task.type,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    assignee: task.assignee,
    estimate: task.estimate,
    dueDate: task.dueDate,
    github:
      task.githubIssueNumber !== null && task.githubIssueUrl
        ? { number: task.githubIssueNumber, url: task.githubIssueUrl, state: task.githubIssueState ?? "open" }
        : null,
    run: runStatus(task),
    latestRun: run
      ? {
          status: run.status,
          stage: run.stage,
          branch: run.branch,
          note: run.error,
        }
      : null,
    pullRequest: pull ? { number: pull.number, url: pull.url, state: pull.state } : null,
  };
}
