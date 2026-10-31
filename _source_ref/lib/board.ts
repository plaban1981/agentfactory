// Board vocabulary shared by the Kanban UI and its server actions.
import type { PullRequestState, TaskRunSummary } from "@/lib/workflow";

export const TASK_STATUSES = ["todo", "in_development", "in_review", "testing", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "Todo",
  in_development: "In development",
  in_review: "In review",
  testing: "Testing",
  done: "Done",
};

export const TASK_TYPES = ["issue", "bug", "feature"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  issue: "Issue",
  bug: "Bug",
  feature: "Feature",
};

export const TASK_PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const AGENT_RUN_STATUSES = ["running", "done", "failed"] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const TASK_ESTIMATES = [1, 2, 3, 5, 8, 13] as const;

export const TASK_TITLE_MIN = 3;
export const TASK_TITLE_MAX = 120;
export const TASK_DESCRIPTION_MAX = 2000;

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isTaskType(value: unknown): value is TaskType {
  return typeof value === "string" && (TASK_TYPES as readonly string[]).includes(value);
}

export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === "string" && (TASK_PRIORITIES as readonly string[]).includes(value);
}

// "Acme Web App" → "AWA", "devcrew" → "DEV". Used as the prefix of task keys like AWA-12.
export function taskKeyPrefix(workspaceName: string) {
  const words = workspaceName.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  const prefix = words.length > 1 ? words.map((word) => word[0]).join("").slice(0, 4) : (words[0] ?? "").slice(0, 3);
  return prefix || "TASK";
}

// A task as sent to the board UI: serializable, with its display key.
export type BoardTask = {
  id: string;
  key: string;
  type: TaskType;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: string | null;
  estimate: number | null;
  // YYYY-MM-DD
  dueDate: string | null;
  // The GitHub issue this task was imported from
  github: { number: number; url: string; state: "open" | "closed" } | null;
  // The latest agent run on the task
  run: AgentRunStatus | null;
  // Where that run is in the pipeline, and why it stopped
  latestRun: TaskRunSummary | null;
  // The pull request the AI team opened for it
  pullRequest: { number: number; url: string; state: PullRequestState } | null;
};

// How often an open board pulls new issues from GitHub.
export const ISSUE_SYNC_INTERVAL_MS = 30_000;
// How often the board refreshes while an agent is working on one of its tasks.
export const RUN_REFRESH_INTERVAL_MS = 10_000;
