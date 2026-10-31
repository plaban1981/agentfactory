"""Budget enforcement for agent runs.

Ported from lib/agent-budget.ts of devcrew-yt-project. Whatever runs an agent must:
  1. call assert_agent_can_run() before the run and before every model or tool call, and
  2. record every cost with record_agent_spend(), never by inserting costed
     activities directly.
A run can overshoot its budget by at most the one step that was already in flight.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional, Union

from .config import BUDGET_WARNING_RATIO, MIN_BALANCE_TO_RUN_CENTS
from .state import ActivityEvent, Agent, Store


def month_start(now: Optional[datetime] = None) -> datetime:
    """Budgets cover a calendar month; spend starts again from zero on the 1st."""
    now = now or datetime.now(timezone.utc)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def format_cents(cents: float, whole: bool = False) -> str:
    if whole:
        return f"${int(round(cents / 100))}"
    return f"${cents / 100:.2f}"


class AgentRunBlockedError(Exception):
    """Raised when a run must not proceed: paused, over budget, or agent missing."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason  # not_found | paused | budget_exhausted


@dataclass
class RunCheck:
    ok: bool
    spent_cents: int = 0
    budget_cents: int = 0
    remaining_cents: int = 0
    reason: Optional[str] = None
    message: str = ""


def monthly_spend(store: Store, agent_id: str, now: Optional[datetime] = None) -> int:
    start = month_start(now)
    return sum(
        e.cost_cents for e in store.activities
        if e.agent_id == agent_id and e.created_at >= start and e.cost_cents > 0
    )


def run_check_for(agent: Agent, spent_cents: int) -> RunCheck:
    """Same rule the run gate applies, so the UI never shows an agent as available
    when runs would be refused."""
    if not agent.enabled:
        return RunCheck(False, reason="paused", message=f"{agent.name} is paused.")
    remaining = agent.budget_cents - spent_cents
    if remaining < MIN_BALANCE_TO_RUN_CENTS:
        return RunCheck(
            False, spent_cents=spent_cents, budget_cents=agent.budget_cents, remaining_cents=remaining,
            reason="budget_exhausted",
            message=f"{agent.name} has used {format_cents(spent_cents)} of its "
                    f"{format_cents(agent.budget_cents, whole=True)} monthly budget.",
        )
    return RunCheck(True, spent_cents=spent_cents, budget_cents=agent.budget_cents, remaining_cents=remaining)


def check_agent_can_run(store: Store, agent_id: str) -> RunCheck:
    agent = store.agents.get(agent_id)
    if agent is None:
        return RunCheck(False, reason="not_found", message="This agent no longer exists.")
    return run_check_for(agent, monthly_spend(store, agent.id))


def assert_agent_can_run(store: Store, agent_id: str) -> RunCheck:
    """Throws AgentRunBlockedError when the agent is paused or out of budget;
    returns what it has left otherwise."""
    check = check_agent_can_run(store, agent_id)
    if not check.ok:
        raise AgentRunBlockedError(check.reason or "not_found", check.message)
    return check


def assert_stage_budget(store: Store, agent: Agent, pending_cents: float) -> None:
    """The agent's spend this stage isn't in the ledger until the stage ends,
    so count it against what's left."""
    check = assert_agent_can_run(store, agent.id)
    if check.remaining_cents - pending_cents < MIN_BALANCE_TO_RUN_CENTS:
        raise AgentRunBlockedError(
            "budget_exhausted",
            f"{agent.name} would go over its monthly budget finishing this task. "
            f"Raise its budget on the AI team page.",
        )


def record_agent_spend(store: Store, agent_id: str, kind: str, title: str,
                       detail: Optional[str], cost_cents: int) -> RunCheck:
    """Records a step's cost and logs the warning and limit notices when the spend
    crosses them. Costs already incurred are always recorded, even when they push
    the agent over its budget."""
    if not isinstance(cost_cents, int) or isinstance(cost_cents, bool) or cost_cents < 0:
        raise ValueError("cost_cents must be a non-negative integer")

    agent = store.agents.get(agent_id)
    if agent is None:
        raise AgentRunBlockedError("not_found", "This agent no longer exists.")

    before = monthly_spend(store, agent.id)
    after = before + cost_cents
    warn_at = round(agent.budget_cents * BUDGET_WARNING_RATIO)

    # The costed activity itself.
    store.log(kind, title, detail, agent_id=agent.id, cost_cents=cost_cents)

    if before < agent.budget_cents and after >= agent.budget_cents:
        store.log(
            "budget_reached", "Monthly budget reached",
            f"Spent {format_cents(after)} of {format_cents(agent.budget_cents, whole=True)}. "
            "New runs are blocked until next month or until the budget is raised.",
            agent_id=agent.id,
        )
    elif before < warn_at and after >= warn_at and after < agent.budget_cents:
        store.log(
            "budget_warning", f"{round(BUDGET_WARNING_RATIO * 100)}% of monthly budget used",
            f"Spent {format_cents(after)} of {format_cents(agent.budget_cents, whole=True)}.",
            agent_id=agent.id,
        )

    return run_check_for(agent, after)
