"""A scripted chat model for offline tests and demos.

Implements bind_tools (no-op) because the Deep Agents runtime calls it before
every model call, and BaseChatModel leaves it unimplemented. Each scripted step
is either a list of tool calls or a plain text answer, consumed in order, which
keeps every pipeline test fully deterministic with no network access.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Optional, Union

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult


class ScriptedChatModel(BaseChatModel):
    """Deterministic model: plays back scripted steps, one per model call.

    A step is:
      {"tool_calls": [{"name": str, "args": dict}, ...]}  -> one AIMessage with tool calls
      {"text": str}                                       -> a plain final answer
    or a callable(messages) -> step dict, for dynamic scripts.
    """

    steps: list[Union[dict, Callable[[list[BaseMessage]], dict]]] = []
    usage_per_call: dict = {"input_tokens": 1200, "output_tokens": 300}

    def __init__(self, steps=None, usage_per_call=None, **kwargs):
        super().__init__(**kwargs)
        if steps is not None:
            self.steps = list(steps)
        if usage_per_call is not None:
            self.usage_per_call = usage_per_call

    @property
    def _llm_type(self) -> str:
        return "scripted-chat-model"

    # The Deep Agents runtime calls this before each model call; BaseChatModel
    # leaves it unimplemented, so a no-op return self is required.
    def bind_tools(self, tools: Any, **kwargs: Any) -> "ScriptedChatModel":
        return self

    def _resolve_step(self, messages: list[BaseMessage]) -> dict:
        # After a submit tool succeeded, end the stage without consuming a
        # scripted step -- mirroring a real model that wraps up once its work
        # is handed in, and keeping cross-stage scripts aligned.
        last = messages[-1] if messages else None
        if last is not None and type(last).__name__ == "ToolMessage":
            content = str(getattr(last, "content", "") or "")
            if content.startswith("Submitted."):
                return {"text": "Stage submitted. Wrapping up."}
        if not self.steps:
            return {"text": "I have nothing left to say."}
        step = self.steps.pop(0)
        if callable(step):
            step = step(messages)
        return step

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: Optional[list[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> ChatResult:
        step = self._resolve_step(messages)
        tool_calls = [
            {"name": tc["name"], "args": tc.get("args", {}), "id": f"call_{abs(hash(json.dumps(tc, sort_keys=True, default=str))) % 10**8}"}
            for tc in step.get("tool_calls", [])
        ]
        message = AIMessage(
            content=step.get("text", ""),
            tool_calls=tool_calls,
            response_metadata={"usage": dict(self.usage_per_call)},
        )
        return ChatResult(generations=[ChatGeneration(message=message)])

    @property
    def model_name(self) -> str:
        return "scripted-chat-model"
