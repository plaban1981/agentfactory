// Workflow vocabulary shared by the settings, board and pull request UIs and the task pipeline.
import type { AgentRole } from "@/lib/ai-team";

// How Todo tasks reach the Analyst: started by hand from the board, or picked up one at a time.
export const TASK_PICKUP_MODES = ["manual", "auto"] as const;
export type TaskPickupMode = (typeof TASK_PICKUP_MODES)[number];

export const TASK_PICKUP_LABELS: Record<TaskPickupMode, { label: string; description: string }> = {
  manual: { label: "Manual", description: "Start each Todo task yourself with the Run button on its card." },
  auto: { label: "Automatic", description: "The Analyst picks up the next Todo task whenever the team is free." },
};

// What happens to a pull request once the Tester opens it.
export const MERGE_MODES = ["manual", "auto"] as const;
export type MergeMode = (typeof MERGE_MODES)[number];

export const MERGE_MODE_LABELS: Record<MergeMode, { label: string; description: string }> = {
  manual: { label: "Manual merge", description: "Pull requests wait for you to review and merge them." },
  auto: { label: "Auto merge", description: "Pull requests are merged as soon as GitHub reports no conflicts and passing checks." },
};

export function isTaskPickupMode(value: unknown): value is TaskPickupMode {
  return typeof value === "string" && (TASK_PICKUP_MODES as readonly string[]).includes(value);
}

export function isMergeMode(value: unknown): value is MergeMode {
  return typeof value === "string" && (MERGE_MODES as readonly string[]).includes(value);
}

// A run moves through these stages in order; review and testing can send it back to development.
export const TASK_RUN_STAGES = ["analysis", "development", "review", "testing", "pull_request", "merge"] as const;
export type TaskRunStage = (typeof TASK_RUN_STAGES)[number];

export const TASK_RUN_STAGE_LABELS: Record<TaskRunStage, string> = {
  analysis: "Analyzing",
  development: "Developing",
  review: "Reviewing",
  testing: "Verifying",
  pull_request: "Opening pull request",
  merge: "Merging",
};

// The agent responsible for each stage. The Tester opens and merges the pull request.
export const STAGE_AGENT: Record<TaskRunStage, AgentRole> = {
  analysis: "analyst",
  development: "developer",
  review: "reviewer",
  testing: "tester",
  pull_request: "tester",
  merge: "tester",
};

// "needs_input" means the Analyst couldn't plan the task without an answer from a person.
export const TASK_RUN_STATUSES = ["running", "done", "failed", "needs_input"] as const;
export type TaskRunStatus = (typeof TASK_RUN_STATUSES)[number];

// How many times review and verification together can send work back to the Developer.
export const MAX_REWORK_ROUNDS = 2;

// Model calls an agent may make in one stage of a run. Each call can use several tools.
export const AGENT_MAX_TURNS_MIN = 5;
export const AGENT_MAX_TURNS_MAX = 200;
export const DEFAULT_MAX_TURNS: Record<AgentRole, number> = {
  analyst: 20,
  developer: 60,
  reviewer: 20,
  tester: 15,
};

export const PULL_REQUEST_STATES = ["open", "merged", "closed"] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

// Why the last merge attempt didn't go through.
export type MergeBlock = "conflict" | "checks_failed" | "error";

// The latest run of a task as sent to the board UI.
export type TaskRunSummary = {
  status: TaskRunStatus;
  stage: TaskRunStage;
  branch: string | null;
  // The error, or the Analyst's question when it needs input
  note: string | null;
};

// A pull request as sent to the Pull Requests page.
export type PullRequestItem = {
  id: string;
  number: number;
  url: string;
  title: string;
  headBranch: string;
  baseBranch: string;
  state: PullRequestState;
  taskKey: string | null;
  openedBy: string | null;
  changedFiles: number;
  additions: number;
  deletions: number;
  mergeBlock: MergeBlock | null;
  mergeError: string | null;
  // The Todo task the Tester filed when the merge failed
  followUpTaskKey: string | null;
  mergedBy: "auto" | "user" | null;
  createdAt: string;
  mergedAt: string | null;
};

// One input item for the next model call: a tool's result, or a nudge from DevCrew.
export type AgentTurnInput =
  | { type: "function_call_output"; call_id: string; output: string }
  | { role: "user"; content: string };

export type AnalystPlan = {
  summary: string;
  plan: string;
  acceptanceCriteria: string[];
  files: string[];
};

export type ReviewResult = {
  verdict: "approve" | "request_changes";
  summary: string;
  findings: { severity: "blocking" | "should_fix" | "nit"; file?: string; comment: string }[];
};

export type VerificationResult = {
  passed: boolean;
  report: string;
  problems: string[];
  // DevCrew's own checks of the branch, run before the Tester
  checks: { title: string; ok: boolean; detail: string }[];
};
