import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";
import { agentActivities, agents, db, pullRequests, tasks, type Agent, type PullRequest, type Task, type TaskRun, type Workspace } from "@/db";
import { getAgentByRole } from "@/lib/agents";
import { TASK_DESCRIPTION_MAX, TASK_TITLE_MAX, taskKeyPrefix } from "@/lib/board";
import { connectionToken, getGithubConnection, GithubAuthError } from "@/lib/github";
import { createPull, getCheckOutcome, getPull, mergePull, type GithubPull } from "@/lib/github-repo";
import { insertTasks, topPosition } from "@/lib/tasks";
import type { MergeBlock, PullRequestItem } from "@/lib/workflow";

const MAX_BODY_CHARS = 60_000;
const MAX_REFRESHED = 20;

// Agents act with the workspace owner's GitHub connection.
export async function ownerGithubToken(workspace: Pick<Workspace, "ownerId">) {
  const connection = await getGithubConnection(workspace.ownerId);
  if (!connection) throw new GithubAuthError("Connect GitHub so the AI team can work on your repository.");
  return connectionToken(connection);
}

export function taskKey(workspace: Pick<Workspace, "name">, task: Pick<Task, "number">) {
  return `${taskKeyPrefix(workspace.name)}-${task.number}`;
}

function pullBody(workspace: Workspace, task: Task, run: TaskRun) {
  const key = taskKey(workspace, task);
  const checked = run.verification?.passed ? "x" : " ";
  const sections = [
    `## Summary\n${run.plan?.summary ?? task.title}`,
    run.developerSummary && `## Changes\n${run.developerSummary}`,
    run.plan?.acceptanceCriteria.length && `## Acceptance criteria\n${run.plan.acceptanceCriteria.map((item) => `- [${checked}] ${item}`).join("\n")}`,
    run.review && `## Review\n**${run.review.verdict === "approve" ? "Approved" : "Changes requested"}** by the Reviewer. ${run.review.summary}`,
    run.verification && `## Verification\n${run.verification.report}`,
    `---\nTask ${key} · Opened by the DevCrew AI team.${task.githubIssueNumber ? `\n\nCloses #${task.githubIssueNumber}` : ""}`,
  ];
  return sections.filter(Boolean).join("\n\n").slice(0, MAX_BODY_CHARS);
}

function pullStats(pull: GithubPull) {
  return { changedFiles: pull.changedFiles, additions: pull.additions, deletions: pull.deletions };
}

// Opens the run's pull request on GitHub and saves it. Safe to repeat: an existing pull request is reused.
export async function openPullRequest(input: { workspace: Workspace; task: Task; run: TaskRun; tester: Agent; token: string }) {
  const { workspace, task, run, tester, token } = input;
  if (!run.branch || !run.baseBranch) throw new Error("The run has no branch to open a pull request from.");

  const title = `${taskKey(workspace, task)}: ${task.title}`.slice(0, 250);
  const body = pullBody(workspace, task, run);
  const pull = await createPull(token, workspace.repoId, {
    owner: workspace.repoFullName.split("/")[0],
    title,
    body,
    head: run.branch,
    base: run.baseBranch,
  });

  const values = {
    workspaceId: workspace.id,
    taskId: task.id,
    runId: run.id,
    openedByAgentId: tester.id,
    number: pull.number,
    url: pull.url,
    title,
    body,
    headBranch: run.branch,
    baseBranch: run.baseBranch,
    ...pullStats(pull),
  };
  const [saved] = await db
    .insert(pullRequests)
    .values(values)
    .onConflictDoUpdate({ target: [pullRequests.workspaceId, pullRequests.number], set: { ...values, updatedAt: new Date() } })
    .returning();

  await db.insert(agentActivities).values({
    workspaceId: workspace.id,
    agentId: tester.id,
    kind: "pr_opened",
    title: `Opened pull request #${pull.number} ${task.title}`,
    detail: `${pull.changedFiles} files changed, +${pull.additions} −${pull.deletions}`,
  });
  return saved;
}

export type MergeAttempt =
  | { outcome: "merged" }
  | { outcome: "closed" }
  | { outcome: "pending"; message: string }
  | { outcome: "blocked"; block: MergeBlock; message: string };

// Merges a pull request if GitHub reports no conflicts and no failing or running checks.
// A conflict or a failed check makes the Tester file a Todo task with the details, once per pull request.
export async function attemptMerge(workspace: Workspace, pr: PullRequest, token: string, by: "auto" | "user"): Promise<MergeAttempt> {
  const pull = await getPull(token, workspace.repoId, pr.number);
  if (pull.merged) {
    await markMerged(workspace, pr, pull.mergeCommitSha, by === "auto" ? "user" : by, pull);
    return { outcome: "merged" };
  }
  if (pull.state === "closed") {
    await db.update(pullRequests).set({ state: "closed", updatedAt: new Date() }).where(eq(pullRequests.id, pr.id));
    return { outcome: "closed" };
  }
  if (pull.mergeable === null) return { outcome: "pending", message: "GitHub is still checking this pull request for conflicts." };
  if (pull.mergeable === false || pull.mergeableState === "dirty") {
    return block(workspace, pr, "conflict", `#${pr.number} has merge conflicts with ${pr.baseBranch}.`, conflictDetails(pr, pull));
  }

  const checks = await getCheckOutcome(token, workspace.repoId, pull.headSha);
  if (checks.state === "failure") {
    const details = checks.failures.map((failure) => `- **${failure.name}**: ${failure.detail}${failure.url ? ` (${failure.url})` : ""}`).join("\n");
    return block(workspace, pr, "checks_failed", `${checks.failures.length} check${checks.failures.length === 1 ? "" : "s"} failed on #${pr.number}.`, details);
  }
  if (checks.state === "pending") return { outcome: "pending", message: `Checks are still running: ${checks.pending.slice(0, 5).join(", ")}.` };

  const result = await mergePull(token, workspace.repoId, pr.number, pull.headSha, pr.title);
  if (result.merged) {
    await markMerged(workspace, pr, result.sha, by, pull);
    return { outcome: "merged" };
  }
  if (result.status === 409) return { outcome: "pending", message: "The branch changed while merging. Try again in a moment." };
  if (/conflict/i.test(result.message)) return block(workspace, pr, "conflict", `#${pr.number} has merge conflicts with ${pr.baseBranch}.`, result.message);
  // Branch protection, required reviews and similar rules need a person, so they don't file a task.
  return block(workspace, pr, "error", `GitHub refused the merge: ${result.message}`, null);
}

function conflictDetails(pr: PullRequest, pull: GithubPull) {
  return `GitHub reports that \`${pr.headBranch}\` can't be merged into \`${pr.baseBranch}\` without conflicts (mergeable state: ${pull.mergeableState}). Bring the branch up to date with \`${pr.baseBranch}\`, resolve the conflicts in the ${pull.changedFiles} changed files and keep the original change working.`;
}

async function block(workspace: Workspace, pr: PullRequest, kind: MergeBlock, message: string, details: string | null): Promise<MergeAttempt> {
  await db
    .update(pullRequests)
    .set({ mergeBlock: kind, mergeError: message, updatedAt: new Date() })
    .where(eq(pullRequests.id, pr.id));
  if (kind !== "error" && !pr.followUpTaskId) await fileFollowUp(workspace, pr, kind, message, details ?? "");
  return { outcome: "blocked", block: kind, message };
}

// The Tester reports a merge conflict or a failed build as a new Todo task, so the team can fix it.
async function fileFollowUp(workspace: Workspace, pr: PullRequest, kind: Exclude<MergeBlock, "error">, message: string, details: string) {
  const tester = await getAgentByRole(workspace.id, "tester");
  const original = pr.taskId ? await db.query.tasks.findFirst({ where: and(eq(tasks.id, pr.taskId), eq(tasks.workspaceId, workspace.id)) }) : null;
  const what = kind === "conflict" ? "merge conflicts" : "failing checks";
  const description = [
    `${message} Found by the Tester while merging [pull request #${pr.number}](${pr.url}).`,
    `**Branch:** \`${pr.headBranch}\` → \`${pr.baseBranch}\``,
    original ? `**Original task:** ${taskKey(workspace, original)} ${original.title}` : null,
    details ? `**Details:**\n${details}` : null,
    `Fix the ${what}, then merge #${pr.number} or replace it with a new pull request.`,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, TASK_DESCRIPTION_MAX);

  const [taskId] = await insertTasks(workspace.id, [
    {
      type: "bug",
      title: `Fix ${what} in #${pr.number} ${original?.title ?? pr.title}`.slice(0, TASK_TITLE_MAX),
      description,
      priority: "high",
      status: "todo",
      assignee: tester?.name ?? null,
      createdById: workspace.ownerId,
    },
  ]);
  if (!taskId) return;
  await db.update(pullRequests).set({ followUpTaskId: taskId }).where(eq(pullRequests.id, pr.id));
  if (tester) {
    await db.insert(agentActivities).values({
      workspaceId: workspace.id,
      agentId: tester.id,
      kind: "error",
      title: `Couldn't merge #${pr.number}: ${what}`,
      detail: `${message} Filed a task in Todo with the details.`,
    });
  }
}

async function markMerged(workspace: Workspace, pr: PullRequest, sha: string | null, by: "auto" | "user", pull: GithubPull) {
  const [updated] = await db
    .update(pullRequests)
    .set({
      state: "merged",
      mergedBy: by,
      mergeCommitSha: sha,
      mergedAt: pull.mergedAt ? new Date(pull.mergedAt) : new Date(),
      mergeBlock: null,
      mergeError: null,
      ...pullStats(pull),
      updatedAt: new Date(),
    })
    .where(and(eq(pullRequests.id, pr.id), eq(pullRequests.state, "open")))
    .returning({ id: pullRequests.id });
  if (!updated || !pr.taskId) return;

  // Merged work is done; a task the GitHub sync already moved stays where it is.
  await db
    .update(tasks)
    .set({ status: "done", position: await topPosition(workspace.id, "done"), updatedAt: new Date() })
    .where(and(eq(tasks.id, pr.taskId), eq(tasks.workspaceId, workspace.id), inArray(tasks.status, ["in_development", "in_review", "testing"])));
  if (pr.openedByAgentId) {
    await db.insert(agentActivities).values({
      workspaceId: workspace.id,
      agentId: pr.openedByAgentId,
      kind: "task_completed",
      title: `Merged #${pr.number} ${pr.title}`,
      detail: by === "auto" ? "Merged automatically once checks passed." : "Merged by a person.",
    });
  }
}

// Picks up merges and closes done on GitHub since the page was last opened. Best effort.
export async function refreshOpenPullRequests(workspace: Workspace) {
  const open = await db.query.pullRequests.findMany({
    where: and(eq(pullRequests.workspaceId, workspace.id), eq(pullRequests.state, "open")),
    orderBy: desc(pullRequests.createdAt),
    limit: MAX_REFRESHED,
  });
  if (open.length === 0) return;
  const token = await ownerGithubToken(workspace);
  await Promise.all(
    open.map(async (pr) => {
      try {
        const pull = await getPull(token, workspace.repoId, pr.number);
        if (pull.merged) await markMerged(workspace, pr, pull.mergeCommitSha, "user", pull);
        else if (pull.state === "closed") {
          await db.update(pullRequests).set({ state: "closed", updatedAt: new Date() }).where(eq(pullRequests.id, pr.id));
        } else {
          await db.update(pullRequests).set(pullStats(pull)).where(eq(pullRequests.id, pr.id));
        }
      } catch (error) {
        if (error instanceof GithubAuthError) throw error;
        console.error(`Couldn't refresh pull request #${pr.number}`, error);
      }
    }),
  );
}

export async function getPullRequest(workspaceId: string, id: string): Promise<PullRequest | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const row = await db.query.pullRequests.findFirst({ where: and(eq(pullRequests.id, id), eq(pullRequests.workspaceId, workspaceId)) });
  return row ?? null;
}

export async function listPullRequests(workspace: Pick<Workspace, "id" | "name">): Promise<PullRequestItem[]> {
  const rows = await db.query.pullRequests.findMany({
    where: eq(pullRequests.workspaceId, workspace.id),
    orderBy: desc(pullRequests.createdAt),
    limit: 100,
  });
  const taskIds = [...new Set(rows.flatMap((row) => [row.taskId, row.followUpTaskId]).filter((id): id is string => !!id))];
  const agentIds = [...new Set(rows.map((row) => row.openedByAgentId).filter((id): id is string => !!id))];
  const [taskRows, agentRows] = await Promise.all([
    taskIds.length
      ? db.query.tasks.findMany({ where: and(eq(tasks.workspaceId, workspace.id), inArray(tasks.id, taskIds)), columns: { id: true, number: true } })
      : [],
    agentIds.length ? db.query.agents.findMany({ where: inArray(agents.id, agentIds), columns: { id: true, name: true } }) : [],
  ]);
  const keyById = new Map(taskRows.map((task) => [task.id, taskKey(workspace, task)]));
  const nameById = new Map(agentRows.map((agent) => [agent.id, agent.name]));

  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    url: row.url,
    title: row.title,
    headBranch: row.headBranch,
    baseBranch: row.baseBranch,
    state: row.state,
    taskKey: row.taskId ? (keyById.get(row.taskId) ?? null) : null,
    openedBy: row.openedByAgentId ? (nameById.get(row.openedByAgentId) ?? null) : null,
    changedFiles: row.changedFiles,
    additions: row.additions,
    deletions: row.deletions,
    mergeBlock: row.mergeBlock,
    mergeError: row.mergeError,
    followUpTaskKey: row.followUpTaskId ? (keyById.get(row.followUpTaskId) ?? null) : null,
    mergedBy: row.mergedBy,
    createdAt: row.createdAt.toISOString(),
    mergedAt: row.mergedAt?.toISOString() ?? null,
  }));
}
