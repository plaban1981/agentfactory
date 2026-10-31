"""Deep Agents wiring: one LangChain Deep Agent per pipeline stage.

Each stage agent is built with create_deep_agent() from deepagents 0.7.32 and:
  - the stage's repo tools + its submit_* tool (see tools.py);
  - the role's ported instructions + the stage brief + a turn-budget note;
  - TodoListMiddleware for in-run planning (the Deep Agents way to keep the
    model organized across a long-horizon stage);
  - ModelCallLimitMiddleware(run_limit=max_turns, exit_behavior="end"), the
    Deep Agents replacement for the original hand-rolled max-turns circuit
    breaker (lib/task-runs.ts refuses another turn once turns >= maxTurns);
  - BudgetMiddleware, which re-implements the original per-turn budget gate:
    assertAgentCanRun() before every model call and every tool call, counting
    the stage's not-yet-recorded spend (assertStageBudget in task-runs.ts).

Spend and call counts are tracked per model call by CostTracker, mirroring how
the original loop accumulates pendingCost += response.costCents per turn.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from langchain.agents.middleware import AgentMiddleware, ModelCallLimitMiddleware, TodoListMiddleware
from langchain.agents.middleware.types import ToolCallRequest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.types import Command

from deepagents import create_deep_agent

from .budget import AgentRunBlockedError, assert_stage_budget
from .llm import cost_cents, usage_from_message
from .state import Agent, Store
from .tools import STAGE_BRIEFS, stage_tools, SubmissionBox, ToolContext


class BudgetMiddleware(AgentMiddleware):
    """Fails the stage the moment the agent is paused, over budget, or would go
    over budget with the spend still in flight. State lives on the instance,
    initialized in __init__ (tool nodes run outside run(), so nothing may be
    initialized lazily)."""

    def __init__(self, store: Store, agent: Agent):
        super().__init__()
        self._store = store
        self._agent = agent
        self.pending_cost_cents = 0.0

    # Before every model call.
    def before_model(self, state, runtime):
        assert_stage_budget(self._store, self._agent, self.pending_cost_cents)
        return None

    # Before every tool call.
    def wrap_tool_call(self, request: ToolCallRequest, handler) -> Command:
        assert_stage_budget(self._store, self._agent, self.pending_cost_cents)
        return handler(request)


class CostTracker(BaseChatModel):
    """Wraps a chat model so every model call adds its cost to the budget
    middleware's pending spend and bumps the call counter, exactly like
    `pendingCost += response.costCents` in the original turn loop.

    It must be a BaseChatModel subclass: create_deep_agent() passes models that
    fail isinstance(model, BaseChatModel) to init_chat_model() as if they were
    provider spec strings."""

    model: Any = None
    budget: Any = None
    model_name: str = ""
    # Shared with every clone bind_tools() creates (the runtime invokes the
    # bound clone, so a plain per-instance int would read 0 at the end).
    calls: Any = None

    def __init__(self, **kwargs):
        if kwargs.get("calls") is None:
            kwargs["calls"] = [0]
        super().__init__(**kwargs)

    @property
    def _llm_type(self) -> str:
        return "cost-tracker"

    @property
    def call_count(self) -> int:
        return self.calls[0]

    def bind_tools(self, tools: Any, **kwargs: Any) -> "CostTracker":
        bound = self.model.bind_tools(tools, **kwargs) if hasattr(self.model, "bind_tools") else self.model
        return CostTracker(model=bound, budget=self.budget, model_name=self.model_name, calls=self.calls)

    def _record(self, message) -> None:
        self.calls[0] += 1
        usage = usage_from_message(message)
        if usage:
            self.budget.pending_cost_cents += cost_cents(usage, self.model_name)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        output = self.model.invoke(messages, stop=stop, **kwargs)
        self._record(output)
        return ChatResult(generations=[ChatGeneration(message=output)])


def stage_system_prompt(agent: Agent, stage: str) -> str:
    """instructions + STAGE_BRIEFS + turn budget, matching the original prompt
    assembly in agentStage() of lib/task-runs.ts."""
    return (
        f"{agent.instructions}\n\n"
        f"# This run\n{STAGE_BRIEFS[stage]}\n"
        f"You have {agent.max_turns} turns for this stage. Make every turn count."
    )


def build_stage_agent(stage: str, agent_cfg: Agent, store: Store, tool_ctx: ToolContext,
                      model, model_name: str, box: SubmissionBox,
                      validator: Optional[Callable[[dict], None]] = None):
    """Builds (but does not run) the Deep Agent for one pipeline stage.

    Returns (agent_graph, budget, tracker)."""
    tools, _submit_name = stage_tools(stage, tool_ctx, box, validator=validator)
    budget = BudgetMiddleware(store, agent_cfg)
    tracker = CostTracker(model=model, budget=budget, model_name=model_name)
    agent_graph = create_deep_agent(
        model=tracker,
        tools=tools,
        system_prompt=stage_system_prompt(agent_cfg, stage),
        middleware=[
            budget,
            ModelCallLimitMiddleware(run_limit=agent_cfg.max_turns, exit_behavior="end"),
            TodoListMiddleware(),
        ],
        name=f"devcrew-{stage}",
    )
    return agent_graph, budget, tracker
