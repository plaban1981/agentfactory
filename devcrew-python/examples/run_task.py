"""Minimal live example: one task through the full pipeline on OpenRouter.

Setup:
    copy .env.example to .env and set OPENROUTER_API_KEY

Run:
    python examples/run_task.py "Add a delete_task function to the task store"
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from dotenv import load_dotenv

load_dotenv()

from devcrew.factory import add_task, create_workspace
from devcrew.llm import build_llm
from devcrew.pipeline import start_task_run

title = sys.argv[1] if len(sys.argv) > 1 else "Add a delete_task function to the task store"

store, repo = create_workspace(Path(".devcrew-live") / "workspace", name="Dev Crew", merge_mode="auto")
task = add_task(store, title, "Live run via examples/run_task.py.")
model = build_llm()  # OpenRouter, anthropic/claude-sonnet-5.5 by default
print(f"Running '{title}' on {model.model} ...")

error = start_task_run(store, repo, task, model, model.model)
if error:
    print(f"ERROR: {error}")
    sys.exit(1)

run = store.run_for_task(task.id)
print(f"\nrun: {run.status}" + (f" -- {run.error}" if run.error else ""))
pr = store.latest_pr_for_run(run.id)
if pr:
    print(f"PR #{pr.number}: {pr.title} [{pr.state}] (+{pr.additions}/-{pr.deletions})")
store.save_ledger(Path(".devcrew-live") / "workspace" / "activity.jsonl")
