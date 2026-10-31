"""Shared demo assets: the scripted offline model and the console event sink.

Used by both the CLI (`devcrew.cli`) and the UI server (`devcrew.ui.app`), so
the offline demo behaves identically on both surfaces.
"""

from __future__ import annotations

from .budget import format_cents
from .stub import ScriptedChatModel


def offline_model() -> ScriptedChatModel:
    """A deterministic stand-in for the real LLM: the Analyst explores and
    plans, the Developer writes, the Reviewer approves, the Tester passes."""
    return ScriptedChatModel(steps=[
        # analysis
        {"tool_calls": [{"name": "list_files", "args": {}}]},
        {"tool_calls": [{"name": "read_file", "args": {"path": "src/tasks.py"}}]},
        {"tool_calls": [{"name": "submit_analysis", "args": {
            "decision": "develop",
            "summary": "Extend src/tasks.py with a delete_task function.",
            "plan": "1. Add delete_task(title) to src/tasks.py.\n2. Keep list_tasks() behaviour unchanged.",
            "acceptance_criteria": '["delete_task removes the task", "Unknown titles are a no-op"]',
            "files": '["src/tasks.py"]'}}]},
        # development
        {"tool_calls": [{"name": "write_file", "args": {
            "path": "src/tasks.py",
            "content": '"""In-memory task store."""\n\n_tasks: list[str] = []\n\n\ndef add_task(title: str) -> None:\n    _tasks.append(title)\n\n\ndef delete_task(title: str) -> None:\n    if title in _tasks:\n        _tasks.remove(title)\n\n\ndef list_tasks() -> list[str]:\n    return list(_tasks)\n',
            "commit_message": "Add delete_task to the task store"}}]},
        {"tool_calls": [{"name": "get_diff", "args": {}}]},
        {"tool_calls": [{"name": "submit_work", "args": {
            "summary": "Added delete_task(title); unknown titles are a no-op."}}]},
        # review
        {"tool_calls": [{"name": "get_diff", "args": {}}]},
        {"tool_calls": [{"name": "submit_review", "args": {
            "verdict": "approve", "summary": "Small, correct, matches conventions.", "findings": "[]"}}]},
        # testing
        {"tool_calls": [{"name": "get_diff", "args": {}}]},
        {"tool_calls": [{"name": "submit_verification", "args": {
            "passed": True,
            "report": "Branch exists with 1 commit; planned file src/tasks.py changed; no protected files touched.",
            "problems": "[]"}}]},
    ])


def print_event(event: dict) -> None:
    """Console rendering of pipeline events (ASCII-safe for Windows cp1252)."""
    t = event.get("type")
    if t == "stage":
        print(f"\n=== [{event['label']}]"
              + (f" (round {event['round']})" if event.get("round") else "")
              + (f" on {event['branch']}" if event.get("branch") else "")
              + " ===")
    elif t == "agent_start":
        print(f"  > {event['agent']} starts ({event['turns_budget']} turns budget)")
    elif t == "agent_end":
        print(f"  > {event['agent']} done: {event['model_calls']} model calls,"
              f" ~{format_cents(event['pending_cost_cents'])} this stage")
    elif t == "branch_created":
        print(f"  > branch created: {event['branch']}")
    elif t == "pr_opened":
        print(f"  > PR #{event['number']} opened: {event['title']}")
    elif t == "run_finished":
        note = f" -- {event['note']}" if event.get("note") else ""
        print(f"\n*** RUN {event['status'].upper()}{note}")
