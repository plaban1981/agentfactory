// AI team vocabulary shared by the AI Team UI and its server actions.

export const AGENT_ROLES = ["analyst", "developer", "reviewer", "tester"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  analyst: "Analyst",
  developer: "Developer",
  reviewer: "Reviewer",
  tester: "Tester",
};

export const AGENT_SKILLS = [
  { id: "requirements-analysis", label: "Requirements analysis" },
  { id: "task-breakdown", label: "Task breakdown" },
  { id: "acceptance-criteria", label: "Acceptance criteria" },
  { id: "codebase-exploration", label: "Codebase exploration" },
  { id: "technical-writing", label: "Technical writing" },
  { id: "feature-implementation", label: "Feature implementation" },
  { id: "bug-fixing", label: "Bug fixing" },
  { id: "refactoring", label: "Refactoring" },
  { id: "git-workflow", label: "Git workflow" },
  { id: "dependency-management", label: "Dependency management" },
  { id: "code-review", label: "Code review" },
  { id: "security-audit", label: "Security audit" },
  { id: "performance-review", label: "Performance review" },
  { id: "accessibility-review", label: "Accessibility review" },
  { id: "unit-testing", label: "Unit testing" },
  { id: "e2e-testing", label: "End-to-end testing" },
  { id: "regression-testing", label: "Regression testing" },
  { id: "bug-reporting", label: "Bug reporting" },
] as const;
export type AgentSkill = (typeof AGENT_SKILLS)[number]["id"];

export const DEFAULT_AGENT_SKILLS: Record<AgentRole, AgentSkill[]> = {
  analyst: ["requirements-analysis", "task-breakdown", "acceptance-criteria", "codebase-exploration", "technical-writing"],
  developer: ["feature-implementation", "bug-fixing", "refactoring", "git-workflow", "dependency-management"],
  reviewer: ["code-review", "security-audit", "performance-review", "accessibility-review"],
  tester: ["unit-testing", "e2e-testing", "regression-testing", "bug-reporting"],
};

// The built-in tools of the OpenAI Agents SDK. Every agent can use all of them.
export const AGENT_TOOLS = [
  { id: "web_search", label: "Web search", description: "Searches the web for docs, issues and changelogs." },
  { id: "file_search", label: "File search", description: "Searches the repository's indexed files." },
  { id: "code_interpreter", label: "Code interpreter", description: "Runs Python in a sandbox to analyze data and logs." },
  { id: "shell", label: "Shell", description: "Runs commands such as builds and test suites." },
  { id: "apply_patch", label: "Apply patch", description: "Creates, edits and deletes files with diffs." },
  { id: "computer_use", label: "Computer use", description: "Drives a browser to check the running app." },
  { id: "image_generation", label: "Image generation", description: "Creates diagrams, mockups and assets." },
  { id: "hosted_mcp", label: "Hosted MCP", description: "Calls tools on connected MCP servers, like GitHub." },
] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number]["id"];

// Tools that change files or act outside the sandbox; the trust scan expects guardrails for them.
export const HIGH_IMPACT_TOOLS: AgentTool[] = ["shell", "apply_patch", "computer_use"];

export const AGENT_DESCRIPTION_MAX = 280;
export const AGENT_INSTRUCTIONS_MIN = 50;
export const AGENT_INSTRUCTIONS_MAX = 8000;
export const AGENT_SKILLS_MAX = 12;
// Monthly budget in whole US dollars.
export const AGENT_BUDGET_MIN = 1;
export const AGENT_BUDGET_MAX = 5000;
// Share of the monthly budget at which the agent's activity gets a warning.
export const BUDGET_WARNING_RATIO = 0.8;
// The smallest balance an agent needs left to start a run or a step.
export const MIN_BALANCE_TO_RUN_CENTS = 25;

// An agent counts as working for this long after it starts a task, unless it finishes or fails first.
export const AGENT_WORKING_WINDOW_MS = 2 * 60 * 60 * 1000;

export type AgentStatus = "working" | "idle" | "paused" | "over_budget";

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  working: "Working",
  idle: "Idle",
  paused: "Paused",
  over_budget: "Budget reached",
};

export const AGENT_ACTIVITY_KINDS = [
  "joined",
  "configured",
  "scan",
  "task_started",
  "task_completed",
  "pr_opened",
  "review",
  "test_run",
  "error",
  "budget_warning",
  "budget_reached",
] as const;
export type AgentActivityKind = (typeof AGENT_ACTIVITY_KINDS)[number];

export type TrustFinding = {
  level: "pass" | "warn" | "fail";
  title: string;
  detail?: string;
  // "check" for DevCrew's built-in rules, "ai" for the OpenAI review
  source?: "check" | "ai";
};

// Budgets cover a calendar month; spend starts again from zero on the 1st.
export function nextBudgetReset(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}

export function isAgentSkill(value: unknown): value is AgentSkill {
  return typeof value === "string" && AGENT_SKILLS.some((skill) => skill.id === value);
}

export function skillLabel(id: string) {
  return AGENT_SKILLS.find((skill) => skill.id === id)?.label ?? id;
}

// Switch Trust (switchagents.ai) red-teams each agent through its evaluation service.
export const SWITCH_TRUST_DEFAULT_INSTANCE = "https://app.switchagents.ai";
export const SWITCH_SCAN_STATUSES = ["queued", "running", "done", "failed"] as const;
export type SwitchScanStatus = (typeof SWITCH_SCAN_STATUSES)[number];

export type SwitchEvaluationResult = {
  name: string;
  // The run's status in Switch Trust: queued, running, finished, error or cancelled
  status: string;
  score: number | null;
};

export type SwitchCoverage = { code: string; passing: number; atRisk: number; notRun: number; total: number };

export type SwitchReport = {
  evaluations: SwitchEvaluationResult[];
  coverage: SwitchCoverage[];
  previousScore: number | null;
  // What the scan's model calls cost, in US cents
  costCents: number;
};

export type AgentSwitchSummary = {
  status: SwitchScanStatus | null;
  score: number | null;
  report: SwitchReport | null;
  scannedAt: string | null;
  error: string | null;
  // The configuration changed after the last Switch scan.
  stale: boolean;
};

// The workspace's Switch Trust connection as shown in the UI. The API key never leaves the server.
export type SwitchTrustOverview = {
  instance: string;
  tenantId: string;
  workspaceId: string;
  connectedAt: string;
  roi: {
    monthToDateCents: number;
    capCents: number;
    healthy: number;
    nearCap: number;
    overCap: number;
    noCap: number;
  } | null;
};

// An agent as sent to the AI Team UI: serializable, with this month's spend and its display status.
export type AgentSummary = {
  id: string;
  role: AgentRole;
  name: string;
  description: string;
  instructions: string;
  skills: string[];
  budgetCents: number;
  maxTurns: number;
  enabled: boolean;
  status: AgentStatus;
  switch: AgentSwitchSummary;
  spentCents: number;
  runs: number;
  lastActiveAt: string | null;
};

export type AgentActivityItem = {
  id: string;
  kind: AgentActivityKind;
  title: string;
  detail: string | null;
  costCents: number;
  createdAt: string;
};
