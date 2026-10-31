"""In-memory state: the workspace, agents, tasks, runs and pull requests.

The original app persists these in Postgres via Drizzle; the PoC keeps the exact
same shapes in memory (plus a JSONL activity ledger), which keeps the logic
identical while staying runnable anywhere.
"""

from __future__ import annotations

import itertools
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class Agent:
    id: str
    workspace_id: str
    role: str
    name: str
    description: str
    instructions: str
    skills: list[str]
    budget_cents: int
    max_turns: int
    enabled: bool = True
    trust_score: Optional[int] = None
    trust_findings: list[dict] = field(default_factory=list)


@dataclass
class Task:
    id: str
    workspace_id: str
    number: int
    title: str
    description: Optional[str]
    type: str = "feature"           # issue | bug | feature
    priority: str = "medium"        # low | medium | high | urgent
    status: str = "todo"
    assignee: Optional[str] = None
    agent_run_status: Optional[str] = None
    position: int = 0


@dataclass
class AnalystPlan:
    summary: str
    plan: str
    acceptance_criteria: list[str]
    files: list[str]


@dataclass
class ReviewResult:
    verdict: str                    # approve | request_changes
    summary: str
    findings: list[dict] = field(default_factory=list)


@dataclass
class VerificationResult:
    passed: bool
    report: str
    problems: list[str] = field(default_factory=list)
    checks: list[dict] = field(default_factory=list)


@dataclass
class TaskRun:
    id: str
    workspace_id: str
    task_id: str
    stage: str = "analysis"
    status: str = "running"
    round: int = 0
    base_branch: str = "main"
    branch: Optional[str] = None
    plan: Optional[AnalystPlan] = None
    developer_summary: Optional[str] = None
    review: Optional[ReviewResult] = None
    verification: Optional[VerificationResult] = None
    feedback: Optional[str] = None
    stage_turns: int = 0
    pending_cost_cents: float = 0.0
    error: Optional[str] = None
    created_at: datetime = field(default_factory=_now)
    finished_at: Optional[datetime] = None


@dataclass
class PullRequest:
    id: str
    workspace_id: str
    run_id: str
    number: int
    title: str
    head_branch: str
    base_branch: str
    state: str = "open"             # open | merged | closed
    opened_by: Optional[str] = None
    changed_files: int = 0
    additions: int = 0
    deletions: int = 0
    merge_block: Optional[str] = None
    merge_error: Optional[str] = None
    follow_up_task_key: Optional[str] = None
    merged_by: Optional[str] = None
    created_at: datetime = field(default_factory=_now)
    merged_at: Optional[datetime] = None


@dataclass
class ActivityEvent:
    workspace_id: str
    agent_id: Optional[str]
    kind: str
    title: str
    detail: Optional[str]
    cost_cents: int = 0
    created_at: datetime = field(default_factory=_now)


class Store:
    """One workspace's data: agents, tasks, runs, PRs and the activity ledger."""

    def __init__(self, workspace_id: str, name: str, repo_path: Path, default_branch: str = "main",
                 task_pickup: str = "manual", merge_mode: str = "manual"):
        self.workspace_id = workspace_id
        self.name = name
        self.repo_path = Path(repo_path)
        self.default_branch = default_branch
        self.task_pickup = task_pickup
        self.merge_mode = merge_mode
        self.agents: dict[str, Agent] = {}
        self.tasks: dict[str, Task] = {}
        self.runs: dict[str, TaskRun] = {}
        self.pull_requests: dict[str, PullRequest] = {}
        self.activities: list[ActivityEvent] = []
        self._seq = itertools.count(1)
        self._pr_seq = itertools.count(1)

    # -- ids -----------------------------------------------------------------
    def new_id(self) -> str:
        return str(uuid.uuid4())

    # -- activity ledger ------------------------------------------------------
    def log(self, kind: str, title: str, detail: Optional[str] = None,
            agent_id: Optional[str] = None, cost_cents: int = 0) -> ActivityEvent:
        event = ActivityEvent(self.workspace_id, agent_id, kind, title, detail, cost_cents)
        self.activities.append(event)
        return event

    def save_ledger(self, path: Path) -> None:
        """Dump the activity ledger as JSONL (the PoC's observability trail)."""
        with open(path, "w", encoding="utf-8") as fh:
            for event in self.activities:
                fh.write(json.dumps({
                    "at": event.created_at.isoformat(),
                    "kind": event.kind,
                    "title": event.title,
                    "detail": event.detail,
                    "agent_id": event.agent_id,
                    "cost_cents": event.cost_cents,
                }, ensure_ascii=False) + "\n")

    # -- lookup helpers -------------------------------------------------------
    def agent_by_role(self, role: str) -> Optional[Agent]:
        for agent in self.agents.values():
            if agent.role == role:
                return agent
        return None

    def run_for_task(self, task_id: str) -> Optional[TaskRun]:
        runs = [r for r in self.runs.values() if r.task_id == task_id]
        return max(runs, key=lambda r: r.created_at) if runs else None

    def latest_pr_for_run(self, run_id: str) -> Optional[PullRequest]:
        prs = [p for p in self.pull_requests.values() if p.run_id == run_id]
        return max(prs, key=lambda p: p.created_at) if prs else None


def task_key(workspace_name: str, task: Task) -> str:
    """DEV-12-style key, same as taskKey() in the original app."""
    prefix = "".join(word[0] for word in workspace_name.split() if word).upper() or "TASK"
    return f"{prefix}-{task.number}"
