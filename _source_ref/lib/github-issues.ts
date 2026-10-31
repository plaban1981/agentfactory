import "server-only";

import { and, eq, inArray, min } from "drizzle-orm";
import { db, tasks, workspaces, type Task, type Workspace } from "@/db";
import { TASK_DESCRIPTION_MAX, TASK_TITLE_MAX, type TaskPriority, type TaskStatus, type TaskType } from "@/lib/board";
import { connectionToken, getGithubConnection, GithubAuthError, githubFetch } from "@/lib/github";
import { insertTasks, POSITION_STEP } from "@/lib/tasks";

// Board loads and background polls within this window reuse the last sync.
const MIN_SYNC_INTERVAL_MS = 15_000;
// Re-read a little before the last sync so clock skew with GitHub can't drop an update.
const SINCE_OVERLAP_MS = 60_000;
const PER_PAGE = 100;
const MAX_PAGES = 5;

type ApiIssue = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  labels: (string | { name?: string })[];
  assignee: { login: string } | null;
  milestone: { due_on: string | null } | null;
  // Present when the "issue" is a pull request
  pull_request?: unknown;
};

const PRIORITY_LABELS: Record<string, TaskPriority> = {
  urgent: "urgent",
  critical: "urgent",
  blocker: "urgent",
  p0: "urgent",
  high: "high",
  p1: "high",
  medium: "medium",
  normal: "medium",
  p2: "medium",
  low: "low",
  minor: "low",
  p3: "low",
};

function labelNames(issue: ApiIssue) {
  return issue.labels
    .map((label) => (typeof label === "string" ? label : (label.name ?? "")).trim().toLowerCase())
    .filter(Boolean);
}

// The type and priority an issue's labels ask for, or null when no label says.
function typeFromLabels(labels: string[]): TaskType | null {
  if (labels.some((label) => label.includes("bug"))) return "bug";
  if (labels.some((label) => label.includes("feature") || label.includes("enhancement"))) return "feature";
  return null;
}

function priorityFromLabels(labels: string[]): TaskPriority | null {
  for (const label of labels) {
    // "priority: high", "priority/p1" and plain "high" all count.
    const priority = PRIORITY_LABELS[label.replace(/^priority[\s:/_-]*/, "")];
    if (priority) return priority;
  }
  return null;
}

function truncate(text: string, maxLength: number) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

// The fields GitHub owns. Type and priority are only included when a label sets them,
// so changes made on the board survive the next sync.
function issueFields(issue: ApiIssue) {
  const labels = labelNames(issue);
  const body = issue.body?.trim();
  return {
    title: truncate(issue.title.trim(), TASK_TITLE_MAX),
    description: body ? truncate(body, TASK_DESCRIPTION_MAX) : null,
    githubIssueNumber: issue.number,
    githubIssueUrl: issue.html_url,
    type: typeFromLabels(labels),
    priority: priorityFromLabels(labels),
    dueDate: issue.milestone?.due_on ? issue.milestone.due_on.slice(0, 10) : null,
  };
}

async function listIssues(token: string, repoId: number, since: Date | null): Promise<ApiIssue[]> {
  // The first sync imports open issues; later ones read everything that changed, to catch closes and reopens.
  const params = new URLSearchParams({ per_page: String(PER_PAGE), sort: "updated", direction: "desc" });
  params.set("state", since ? "all" : "open");
  if (since) params.set("since", since.toISOString());

  const issues: ApiIssue[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    params.set("page", String(page));
    const batch = await githubFetch<ApiIssue[]>(token, `/repositories/${repoId}/issues?${params}`);
    issues.push(...batch.filter((issue) => !issue.pull_request));
    if (batch.length < PER_PAGE) break;
  }
  return issues;
}

// The changes a fresh copy of an issue makes to its task, or null when nothing changed.
function taskUpdate(task: Task, issue: ApiIssue, topOf: (status: TaskStatus) => number): Partial<Task> | null {
  const { type, priority, dueDate, ...fields } = issueFields(issue);
  const update: Partial<Task> = {};

  for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
    if (task[key] !== fields[key]) Object.assign(update, { [key]: fields[key] });
  }
  if (type && task.type !== type) update.type = type;
  if (priority && task.priority !== priority) update.priority = priority;
  if (dueDate && task.dueDate !== dueDate) update.dueDate = dueDate;

  // Only a close or reopen on GitHub moves the card, so moves made on the board stick.
  if (task.githubIssueState !== issue.state) {
    update.githubIssueState = issue.state;
    // Closing moves the card to done; reopening brings it back to todo only if it was in done.
    const status: TaskStatus | null =
      issue.state === "closed" ? (task.status === "done" ? null : "done") : task.status === "done" ? "todo" : null;
    if (status) {
      update.status = status;
      update.position = topOf(status);
    }
  }

  return Object.keys(update).length > 0 ? update : null;
}

// Imports new open issues from the workspace's repository and applies edits, closes and reopens
// to issues already on the board. `workspace` must have been loaded for `userId` through lib/workspaces.ts.
export async function syncGithubIssues(
  userId: number,
  workspace: Workspace,
  { force = false }: { force?: boolean } = {},
): Promise<{ changed: number }> {
  const lastSync = workspace.issuesSyncedAt;
  if (!force && lastSync && Date.now() - lastSync.getTime() < MIN_SYNC_INTERVAL_MS) return { changed: 0 };

  const connection = await getGithubConnection(userId);
  if (!connection) throw new GithubAuthError("Connect GitHub to load issues from your repository.");

  const startedAt = new Date();
  const since = lastSync ? new Date(lastSync.getTime() - SINCE_OVERLAP_MS) : null;
  const issues = await listIssues(connectionToken(connection), workspace.repoId, since);

  const existing = issues.length
    ? await db.query.tasks.findMany({
        where: and(
          eq(tasks.workspaceId, workspace.id),
          inArray(
            tasks.githubIssueId,
            issues.map((issue) => issue.id),
          ),
        ),
      })
    : [];
  const byIssueId = new Map(existing.map((task) => [task.githubIssueId, task]));

  const tops = await db
    .select({ status: tasks.status, top: min(tasks.position) })
    .from(tasks)
    .where(eq(tasks.workspaceId, workspace.id))
    .groupBy(tasks.status);
  const nextTop = new Map(tops.map((row) => [row.status, (row.top ?? 0) - POSITION_STEP]));
  const topOf = (status: TaskStatus) => {
    const position = nextTop.get(status) ?? 0;
    nextTop.set(status, position - POSITION_STEP);
    return position;
  };

  let changed = 0;
  for (const issue of issues) {
    const task = byIssueId.get(issue.id);
    if (!task) continue;
    const update = taskUpdate(task, issue, topOf);
    if (!update) continue;
    await db
      .update(tasks)
      .set({ ...update, updatedAt: new Date() })
      .where(and(eq(tasks.id, task.id), eq(tasks.workspaceId, workspace.id)));
    changed++;
  }

  // Issues closed before they ever reached the board stay off it. GitHub lists the most recently
  // updated first, and insertTasks puts the first row on top of the column.
  const added = issues
    .filter((issue) => issue.state === "open" && !byIssueId.has(issue.id))
    .map((issue) => {
      const { type, priority, ...fields } = issueFields(issue);
      return {
        ...fields,
        type: type ?? "issue",
        priority: priority ?? "medium",
        status: "todo" as const,
        assignee: issue.assignee?.login ?? null,
        githubIssueId: issue.id,
        githubIssueState: issue.state,
        createdById: userId,
      };
    });
  if (added.length > 0) {
    await insertTasks(workspace.id, added);
    changed += added.length;
  }

  await db
    .update(workspaces)
    .set({ issuesSyncedAt: startedAt })
    .where(and(eq(workspaces.id, workspace.id), eq(workspaces.ownerId, userId)));

  return { changed };
}
