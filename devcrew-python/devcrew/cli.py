"""Step-by-step DevCrew demo CLI.

Two modes:
  offline  - ScriptedChatModel drives every stage; no network, no API key.
             Shows the full Analyst -> Developer -> Reviewer -> Tester -> PR
             -> merge pipeline with a deterministic script.
  live     - Real Deep Agents on OpenRouter (anthropic/claude-sonnet-5.5 by
             default). Requires OPENROUTER_API_KEY in .env or the environment.

Usage:
  python -m devcrew.cli demo --mode offline
  python -m devcrew.cli demo --mode live --task "Add a delete_task function"
  python -m devcrew.cli trust                 # print the team's trust scan
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from dotenv import load_dotenv

from .budget import format_cents, monthly_spend
from .config import AGENT_ROLES
from .demo import offline_model, print_event
from .factory import add_task, create_workspace
from .llm import build_llm, openrouter_configured
from .pipeline import start_task_run
from .stub import ScriptedChatModel


def _print_event(event: dict) -> None:
    print_event(event)


def _offline_model() -> ScriptedChatModel:
    """A deterministic stand-in for the real LLM (shared with the UI server)."""
    return offline_model()


def cmd_demo(args: argparse.Namespace) -> int:
    workdir = Path(args.workdir) if args.workdir else Path(tempfile.mkdtemp(prefix="devcrew-demo-"))
    store, repo = create_workspace(workdir / "workspace", name="Dev Crew", merge_mode=args.merge_mode)

    print("DevCrew Python -- step-by-step pipeline demo")
    print(f"mode={args.mode}  merge_mode={store.merge_mode}  repo={repo.path}")

    print("\n-- AI team (with built-in trust scores) --")
    for role in AGENT_ROLES:
        agent = store.agent_by_role(role)
        print(f"  {agent.name:<10} budget ${agent.budget_cents / 100:>7.2f}/mo"
              f"  max_turns={agent.max_turns:<3} trust={agent.trust_score}/100")

    if args.mode == "live":
        if not openrouter_configured():
            print("\nERROR: OPENROUTER_API_KEY is not set. Copy .env.example to .env"
                  " and add your key, or export the variable.")
            return 1
        model = build_llm()
        model_name = model.model
        print(f"\n-- LLM: OpenRouter {model_name} --")
    else:
        model = _offline_model()
        model_name = "scripted-chat-model (offline)"
        print("\n-- LLM: scripted stub (no network) --")

    task = add_task(store, args.task, args.description or "Created for the demo.",
                    type=args.type, priority=args.priority)
    print(f"\n-- Board: task #{task.number} '{task.title}' added to Todo; pressing Run --")

    error = start_task_run(store, repo, task, model, model_name, event_sink=_print_event)
    if error:
        print(f"ERROR: {error}")
        return 1

    run = store.run_for_task(task.id)
    print("\n-- Control room --")
    print(f"run status : {run.status}" + (f"  (branch: {run.branch})" if run.branch else ""))
    if run.error:
        print(f"note       : {run.error}")
    pr = store.latest_pr_for_run(run.id)
    if pr:
        print(f"PR         : #{pr.number} {pr.title} [{pr.state}]"
              f" (+{pr.additions}/-{pr.deletions}, {pr.changed_files} files)")
    print("\n-- Agent activity ledger --")
    for event in store.activities:
        cost = f"  (~{format_cents(event.cost_cents)})" if event.cost_cents else ""
        print(f"  [{event.created_at:%H:%M:%S}] {event.kind:<15} {event.title}{cost}")

    ledger_path = workdir / "workspace" / "activity.jsonl"
    store.save_ledger(ledger_path)
    print(f"\nledger saved: {ledger_path}")
    print(f"repo kept at: {repo.path} (inspect with: git -C {repo.path} log --oneline --all)")
    return 0


def cmd_trust(_args: argparse.Namespace) -> int:
    with tempfile.TemporaryDirectory() as d:
        store, _ = create_workspace(Path(d) / "workspace")
    print("Built-in trust scan (runTrustChecks) -- the six weighted checks from the original app:\n")
    for role in AGENT_ROLES:
        agent = store.agent_by_role(role)
        print(f"{agent.name} (score {agent.trust_score}/100)")
        for finding in agent.trust_findings:
            mark = {"pass": "[PASS]", "warn": "[WARN]", "fail": "[FAIL]"}[finding["level"]]
            print(f"  {mark} {finding['title']}: {finding['detail']}")
        print()
    return 0


def main(argv: list[str] | None = None) -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(prog="devcrew", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    demo = sub.add_parser("demo", help="run the step-by-step pipeline demo")
    demo.add_argument("--mode", choices=["offline", "live"], default="offline")
    demo.add_argument("--task", default="Add a delete_task function to the task store")
    demo.add_argument("--description", default="")
    demo.add_argument("--type", default="feature", choices=["issue", "bug", "feature"])
    demo.add_argument("--priority", default="medium", choices=["low", "medium", "high", "urgent"])
    demo.add_argument("--merge-mode", dest="merge_mode", default="auto", choices=["manual", "auto"])
    demo.add_argument("--workdir", default="", help="keep the demo workspace here (default: temp dir)")
    demo.set_defaults(func=cmd_demo)

    trust = sub.add_parser("trust", help="print the team's built-in trust scan")
    trust.set_defaults(func=cmd_trust)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
