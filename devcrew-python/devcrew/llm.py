"""LLM access through OpenRouter.

Default model: anthropic/claude-sonnet-5.5 (the workhorse), served through
OpenRouter's OpenAI-compatible endpoint via langchain-openai's ChatOpenAI.
"""

from __future__ import annotations

import os
from typing import Optional

from langchain_openai import ChatOpenAI

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_MODEL = "anthropic/claude-sonnet-5.5"

# Cost estimation defaults (USD per 1M tokens) for spend tracking. Override by
# setting OPENROUTER_PRICE_INPUT / OPENROUTER_PRICE_OUTPUT. These are estimates
# used only for the budget ledger, not for billing.
MODEL_PRICES: dict[str, tuple[float, float]] = {
    "anthropic/claude-sonnet-5.5": (3.00, 15.00),
    "anthropic/claude-haiku-4.5": (1.00, 5.00),
    "openai/gpt-4o-mini": (0.15, 0.60),
    "deepseek/deepseek-chat-v3-0324": (0.27, 1.10),
}


def openrouter_configured() -> bool:
    return bool(os.environ.get("OPENROUTER_API_KEY"))


def build_llm(model: Optional[str] = None, temperature: float = 0.0) -> ChatOpenAI:
    """Builds the chat model pointed at OpenRouter. Requires OPENROUTER_API_KEY."""
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY is not set")
    return ChatOpenAI(
        model=model or os.environ.get("OPENROUTER_MODEL") or DEFAULT_MODEL,
        api_key=api_key,
        base_url=OPENROUTER_BASE_URL,
        temperature=temperature,
    )


def cost_cents(usage: dict, model: str) -> float:
    """Fractional US cents for one response, mirroring costCents() in lib/openai.ts."""
    input_price, output_price = MODEL_PRICES.get(model, MODEL_PRICES[DEFAULT_MODEL])
    input_tok = usage.get("input_tokens") or usage.get("prompt_tokens") or 0
    output_tok = usage.get("output_tokens") or usage.get("completion_tokens") or 0
    return ((input_tok * input_price + output_tok * output_price) / 1_000_000) * 100


def usage_from_message(message) -> dict:
    meta = getattr(message, "response_metadata", {}) or {}
    usage = meta.get("usage") or meta.get("token_usage") or {}
    return usage if isinstance(usage, dict) else {}


def tokens_from_usage(usage: dict) -> tuple[int, int]:
    return (
        int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0),
        int(usage.get("output_tokens") or usage.get("completion_tokens") or 0),
    )
