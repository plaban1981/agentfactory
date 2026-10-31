"""Workspace factory: seeds the default four-agent team and a sample repo,
mirroring createDefaultAgents() in lib/agents.ts and the workspace/repo setup
of the original app. Shared by the tests, the demo and the examples."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from .config import AGENT_ROLES
from .repo import LocalRepo, RepoError
from .state import Agent, Store, Task
from .team import AGENT_DEFAULTS
from .trust import run_trust_checks

SAMPLE_FILES: dict[str, str] = {
    "README.md": "# Taskapp\n\nA tiny task management sample app the DevCrew team works on.\n",
    "src/app.py": '"""Taskapp entry point."""\n\n\ndef main() -> None:\n    print("taskapp")\n\n\nif __name__ == "__main__":\n    main()\n',
    "src/tasks.py": '"""In-memory task store."""\n\n_tasks: list[str] = []\n\n\ndef add_task(title: str) -> None:\n    _tasks.append(title)\n\n\ndef list_tasks() -> list[str]:\n    return list(_tasks)\n',
    "tests/test_tasks.py": "from src.tasks import add_task, list_tasks\n\n\ndef test_add_and_list():\n    add_task('write docs')\n    assert 'write docs' in list_tasks()\n",
    ".env.example": "TASKAPP_ENV=development\n",
}


def create_sample_repo(path: Path, default_branch: str = "main") -> LocalRepo:
    """Seeds the sample repo. Idempotent: re-seeding an existing checkout
    restores the sample files and only commits when something actually changed
    (the UI's Reset relies on this)."""
    import subprocess

    repo = LocalRepo(path, default_branch=default_branch)
    repo.init()
    seeded = subprocess.run(
        ["git", "rev-parse", "--verify", "HEAD"],
        cwd=path, capture_output=True,
    ).returncode == 0
    for rel, content in SAMPLE_FILES.items():
        target = path / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        current = target.read_text(encoding="utf-8", errors="replace") if target.exists() else None
        if not seeded or current != content:
            target.write_text(content, encoding="utf-8")
    repo._git("add", "-A")
    # `git diff --cached --quiet` exits 1 when staged changes exist; only then
    # is there something to commit. (Git prints "nothing to commit" to stdout
    # on Windows, so message-sniffing is unreliable.)
    has_changes = subprocess.run(
        ["git", "diff", "--cached", "--quiet"], cwd=path, capture_output=True,
    ).returncode == 1
    if has_changes:
        repo._git("commit", "-m", "Seed the sample repository")
    return repo


def seed_team(store: Store) -> dict[str, Agent]:
    """Creates the roles a workspace is missing, with trust-scan scores, and logs
    their 'joined' activity -- exactly like createDefaultAgents()."""
    team: dict[str, Agent] = {}
    for role in AGENT_ROLES:
        defaults = AGENT_DEFAULTS[role]
        scan = run_trust_checks(role, defaults["instructions"], defaults["skills"],
                                defaults["budget_cents"])
        agent = Agent(
            id=store.new_id(), workspace_id=store.workspace_id, role=role,
            name=defaults["name"], description=defaults["description"],
            instructions=defaults["instructions"], skills=list(defaults["skills"]),
            budget_cents=defaults["budget_cents"], max_turns=defaults["max_turns"],
            trust_score=scan["score"], trust_findings=scan["findings"],
        )
        store.agents[agent.id] = agent
        team[role] = agent
        store.log("joined", f"{agent.name} joined the team",
                  "Configured with the default instructions, skills and budget.",
                  agent_id=agent.id)
    return team


def create_workspace(root: Path, name: str = "Dev Crew", task_pickup: str = "manual",
                     merge_mode: str = "manual") -> tuple[Store, LocalRepo]:
    root = Path(root)
    repo_path = root / "repo"
    store = Store(workspace_id="ws-demo", name=name, repo_path=repo_path,
                  task_pickup=task_pickup, merge_mode=merge_mode)
    repo = create_sample_repo(repo_path, default_branch="main")
    store.default_branch = repo.default_branch
    seed_team(store)
    return store, repo


def add_task(store: Store, title: str, description: str = "",
             type: str = "feature", priority: str = "medium") -> Task:
    task = Task(id=store.new_id(), workspace_id=store.workspace_id,
                number=next(store._seq), title=title, description=description or None,
                type=type, priority=priority)
    store.tasks[task.id] = task
    return task
