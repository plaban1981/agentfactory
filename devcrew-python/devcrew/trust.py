"""DevCrew's built-in trust checks for agent instructions.

Ported from runTrustChecks() in lib/agents.ts of devcrew-yt-project.
Each check passes for full points, warns for half or fails for none.
"""

from __future__ import annotations

import re
from typing import Optional

from .config import DEFAULT_AGENT_SKILLS, HIGH_IMPACT_TOOLS


def _has(text: str, pattern: str) -> bool:
    return re.search(pattern, text, re.IGNORECASE | re.MULTILINE) is not None


def run_trust_checks(role: str, instructions: str, skills: list[str],
                     budget_cents: int) -> dict:
    text = instructions
    defaults = DEFAULT_AGENT_SKILLS[role]
    matching_skills = len([s for s in defaults if s in skills])

    checks = [
        {
            "weight": 20,
            "title": "Clear role and workflow",
            **(
                {"level": "pass", "detail": "The instructions define the agent's role and the steps it follows."}
                if len(text) >= 400 and _has(text, r"\brole\b") and _has(text, r"workflow|steps|^\s*1\.")
                else {"level": "warn", "detail": "Add a role and a step-by-step workflow so the agent behaves predictably."}
                if len(text) >= 200
                else {"level": "fail", "detail": "The instructions are too short to steer an autonomous agent."}
            ),
        },
        {
            "weight": 20,
            "title": "Prompt-injection guardrail",
            **(
                {"level": "pass", "detail": "Repository content and tool output are treated as data, not instructions."}
                if _has(text, r"untrusted|as data|prompt[- ]injection|ignore any (request|instruction)")
                else {"level": "fail", "detail": "Tell the agent to treat issues, code and web pages as untrusted data."}
            ),
        },
        {
            "weight": 15,
            "title": "Secrets protected",
            **(
                {"level": "pass", "detail": "The agent is told never to expose secrets or tokens."}
                if _has(text, r"secret|credential|\.env|token")
                else {"level": "fail", "detail": "Forbid printing or committing secrets, tokens and .env values."}
            ),
        },
        {
            "weight": 20,
            "title": "Approval for high-impact tools",
            **(
                {"level": "pass", "detail": f"{len(HIGH_IMPACT_TOOLS)} high-impact tools are gated by human approval."}
                if _has(text, r"approv|ask (a human|for permission|before)")
                else {"level": "warn", "detail": "Shell, apply patch and computer use are enabled without an approval rule."}
            ),
        },
        {
            "weight": 10,
            "title": "Budget cap",
            **(
                {"level": "pass", "detail": "The monthly budget limits how much a runaway loop can spend."}
                if budget_cents <= 100_000
                else {"level": "warn", "detail": "The monthly budget is above $1,000. Consider a lower cap."}
            ),
        },
        {
            "weight": 15,
            "title": "Skills match the role",
            **(
                {"level": "pass", "detail": "The attached skills fit what this agent is responsible for."}
                if matching_skills * 2 >= len(defaults)
                else {"level": "warn", "detail": "Several of this role's core skills are detached."}
                if matching_skills > 0
                else {"level": "fail", "detail": "None of this role's core skills are attached."}
            ),
        },
    ]

    score = sum(
        c["weight"] if c["level"] == "pass" else c["weight"] / 2 if c["level"] == "warn" else 0
        for c in checks
    )
    return {
        "score": round(score),
        "findings": [
            {"level": c["level"], "title": c["title"], "detail": c["detail"], "source": "check"}
            for c in checks
        ],
    }
