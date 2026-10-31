"""Workflow vocabulary shared by the pipeline and the CLI.

Ported from lib/workflow.ts and lib/ai-team.ts of devcrew-yt-project.
"""

from __future__ import annotations

# --- Team -------------------------------------------------------------------

AGENT_ROLES: tuple[str, ...] = ("analyst", "developer", "reviewer", "tester")

AGENT_ROLE_LABELS: dict[str, str] = {
    "analyst": "Analyst",
    "developer": "Developer",
    "reviewer": "Reviewer",
    "tester": "Tester",
}

AGENT_SKILLS: tuple[dict[str, str], ...] = (
    {"id": "requirements-analysis", "label": "Requirements analysis"},
    {"id": "task-breakdown", "label": "Task breakdown"},
    {"id": "acceptance-criteria", "label": "Acceptance criteria"},
    {"id": "codebase-exploration", "label": "Codebase exploration"},
    {"id": "technical-writing", "label": "Technical writing"},
    {"id": "feature-implementation", "label": "Feature implementation"},
    {"id": "bug-fixing", "label": "Bug fixing"},
    {"id": "refactoring", "label": "Refactoring"},
    {"id": "git-workflow", "label": "Git workflow"},
    {"id": "dependency-management", "label": "Dependency management"},
    {"id": "code-review", "label": "Code review"},
    {"id": "security-audit", "label": "Security audit"},
    {"id": "performance-review", "label": "Performance review"},
    {"id": "accessibility-review", "label": "Accessibility review"},
    {"id": "unit-testing", "label": "Unit testing"},
    {"id": "e2e-testing", "label": "End-to-end testing"},
    {"id": "regression-testing", "label": "Regression testing"},
    {"id": "bug-reporting", "label": "Bug reporting"},
)

DEFAULT_AGENT_SKILLS: dict[str, list[str]] = {
    "analyst": ["requirements-analysis", "task-breakdown", "acceptance-criteria", "codebase-exploration", "technical-writing"],
    "developer": ["feature-implementation", "bug-fixing", "refactoring", "git-workflow", "dependency-management"],
    "reviewer": ["code-review", "security-audit", "performance-review", "accessibility-review"],
    "tester": ["unit-testing", "e2e-testing", "regression-testing", "bug-reporting"],
}

# The built-in tool catalogue the original app shows in the UI. The Python port
# implements the repo tool subset (see tools.py); the catalogue stays for parity.
AGENT_TOOLS: tuple[dict[str, str], ...] = (
    {"id": "web_search", "description": "Searches the web for docs, issues and changelogs."},
    {"id": "file_search", "description": "Searches the repository's indexed files."},
    {"id": "code_interpreter", "description": "Runs Python in a sandbox to analyze data and logs."},
    {"id": "shell", "description": "Runs commands such as builds and test suites."},
    {"id": "apply_patch", "description": "Creates, edits and deletes files with diffs."},
    {"id": "computer_use", "description": "Drives a browser to check the running app."},
    {"id": "image_generation", "description": "Creates diagrams, mockups and assets."},
    {"id": "hosted_mcp", "description": "Calls tools on connected MCP servers, like GitHub."},
)

# Tools that change files or act outside the sandbox; the trust scan expects guardrails for them.
HIGH_IMPACT_TOOLS: tuple[str, ...] = ("shell", "apply_patch", "computer_use")

AGENT_DESCRIPTION_MAX = 280
AGENT_INSTRUCTIONS_MIN = 50
AGENT_INSTRUCTIONS_MAX = 8000
AGENT_SKILLS_MAX = 12
AGENT_BUDGET_MIN = 1          # whole US dollars, monthly
AGENT_BUDGET_MAX = 5000
BUDGET_WARNING_RATIO = 0.8
MIN_BALANCE_TO_RUN_CENTS = 25
AGENT_WORKING_WINDOW_MS = 2 * 60 * 60 * 1000

AGENT_STATUS_LABELS: dict[str, str] = {
    "working": "Working",
    "idle": "Idle",
    "paused": "Paused",
    "over_budget": "Budget reached",
}

AGENT_ACTIVITY_KINDS: tuple[str, ...] = (
    "joined", "configured", "scan", "task_started", "task_completed",
    "pr_opened", "review", "test_run", "error", "budget_warning", "budget_reached",
)


def skill_label(skill_id: str) -> str:
    for skill in AGENT_SKILLS:
        if skill["id"] == skill_id:
            return skill["label"]
    return skill_id


# --- Workflow ----------------------------------------------------------------

TASK_PICKUP_MODES: tuple[str, ...] = ("manual", "auto")
MERGE_MODES: tuple[str, ...] = ("manual", "auto")

# A run moves through these stages in order; review and testing can send it back to development.
TASK_RUN_STAGES: tuple[str, ...] = ("analysis", "development", "review", "testing", "pull_request", "merge")

TASK_RUN_STAGE_LABELS: dict[str, str] = {
    "analysis": "Analyzing",
    "development": "Developing",
    "review": "Reviewing",
    "testing": "Verifying",
    "pull_request": "Opening pull request",
    "merge": "Merging",
}

# The agent responsible for each stage. The Tester opens and merges the pull request.
STAGE_AGENT: dict[str, str] = {
    "analysis": "analyst",
    "development": "developer",
    "review": "reviewer",
    "testing": "tester",
    "pull_request": "tester",
    "merge": "tester",
}

# Agent stages are the ones driven by a model; pull_request/merge are mechanical.
AGENT_STAGES: tuple[str, ...] = ("analysis", "development", "review", "testing")

TASK_RUN_STATUSES: tuple[str, ...] = ("running", "done", "failed", "needs_input")

# How many times review and verification together can send work back to the Developer.
MAX_REWORK_ROUNDS = 2

AGENT_MAX_TURNS_MIN = 5
AGENT_MAX_TURNS_MAX = 200
DEFAULT_MAX_TURNS: dict[str, int] = {
    "analyst": 20,
    "developer": 60,
    "reviewer": 20,
    "tester": 15,
}

PULL_REQUEST_STATES: tuple[str, ...] = ("open", "merged", "closed")

# Board columns (Kanban statuses) of the original app.
TASK_STATUSES: tuple[str, ...] = ("todo", "in_development", "in_review", "testing", "done")

TASK_TYPE_LABELS: dict[str, str] = {"issue": "Issue", "bug": "Bug", "feature": "Feature"}
TASK_PRIORITY_LABELS: dict[str, str] = {"low": "Low", "medium": "Medium", "high": "High", "urgent": "Urgent"}
