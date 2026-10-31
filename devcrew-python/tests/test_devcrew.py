"""Offline test suite for the DevCrew Python port.

Runs with no network: a ScriptedChatModel plays back each stage's tool calls.
Plain asserts, prints PASS/FAIL per test; exit code 0 only when all are green.

Run:  python -m tests.test_devcrew
"""

from __future__ import annotations

import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from devcrew.budget import (AgentRunBlockedError, assert_agent_can_run,
                            assert_stage_budget, monthly_spend, record_agent_spend,
                            run_check_for)
from devcrew.factory import add_task, create_workspace
from devcrew.pipeline import (branch_checks, create_run_branch, drive_run,
                              merge_stage, pull_request_stage, start_task_run)
from devcrew.repo import LocalRepo, RepoError, is_protected_path, normalize_repo_path
from devcrew.state import Agent, TaskRun
from devcrew.stub import ScriptedChatModel
from devcrew.tools import (SubmissionBox, SubmissionError, parse_analysis,
                           parse_review, parse_verification)
from devcrew.trust import run_trust_checks
from devcrew.team import AGENT_DEFAULTS

PASS = 0
FAIL = 0
FAILURES: list[str] = []


def check(name: str, fn) -> None:
    global PASS, FAIL
    try:
        fn()
        PASS += 1
        print(f"PASS  {name}")
    except Exception as exc:  # noqa: BLE001 - report everything
        FAIL += 1
        FAILURES.append(name)
        print(f"FAIL  {name}: {exc}")


def make_agent(role: str = "analyst", budget_cents: int = 5000, enabled: bool = True) -> Agent:
    d = AGENT_DEFAULTS[role]
    return Agent(id=f"agent-{role}", workspace_id="ws", role=role, name=d["name"],
                 description=d["description"], instructions=d["instructions"],
                 skills=list(d["skills"]), budget_cents=budget_cents,
                 max_turns=d["max_turns"], enabled=enabled)


def fresh_workspace(tmp: Path, **kw):
    return create_workspace(tmp / "ws", **kw)


# --- Budget (lib/agent-budget.ts) -------------------------------------------------


def test_budget_paused():
    store, _ = fresh_workspace(Path(tempfile.mkdtemp()))
    agent = make_agent(enabled=False)
    store.agents[agent.id] = agent
    check_result = run_check_for(agent, 0)
    assert not check_result.ok and check_result.reason == "paused"


def test_budget_exhausted_below_min_balance():
    agent = make_agent(budget_cents=5000)
    check_result = run_check_for(agent, 5000 - 24)  # 24 cents left < MIN_BALANCE_TO_RUN_CENTS
    assert not check_result.ok and check_result.reason == "budget_exhausted"


def test_budget_ok_reports_remaining():
    agent = make_agent(budget_cents=5000)
    check_result = run_check_for(agent, 1000)
    assert check_result.ok and check_result.remaining_cents == 4000


def test_record_spend_logs_warning_at_80_percent():
    store, _ = fresh_workspace(Path(tempfile.mkdtemp()))
    agent = make_agent(budget_cents=1000)
    store.agents[agent.id] = agent
    record_agent_spend(store, agent.id, "task_completed", "step", None, cost_cents=850)
    kinds = [e.kind for e in store.activities]
    assert "budget_warning" in kinds, f"expected budget_warning, got {kinds}"
    assert "budget_reached" not in kinds


def test_record_spend_logs_budget_reached():
    store, _ = fresh_workspace(Path(tempfile.mkdtemp()))
    agent = make_agent(budget_cents=1000)
    store.agents[agent.id] = agent
    record_agent_spend(store, agent.id, "task_completed", "step", None, cost_cents=1000)
    kinds = [e.kind for e in store.activities]
    assert "budget_reached" in kinds


def test_monthly_spend_resets_next_month():
    store, _ = fresh_workspace(Path(tempfile.mkdtemp()))
    agent = make_agent()
    store.agents[agent.id] = agent
    last_month = datetime.now(timezone.utc) - timedelta(days=32)
    store.activities[0].created_at = last_month  # 'joined' event ages out
    record_agent_spend(store, agent.id, "task_completed", "step", None, cost_cents=100)
    assert monthly_spend(store, agent.id) == 100


def test_assert_agent_can_run_raises_when_blocked():
    store, _ = fresh_workspace(Path(tempfile.mkdtemp()))
    agent = make_agent(budget_cents=30)
    store.agents[agent.id] = agent
    record_agent_spend(store, agent.id, "task_completed", "step", None, cost_cents=20)
    try:
        assert_agent_can_run(store, agent.id)
        raise AssertionError("expected AgentRunBlockedError")
    except AgentRunBlockedError as exc:
        assert exc.reason == "budget_exhausted"


def test_assert_stage_budget_counts_pending():
    store, _ = fresh_workspace(Path(tempfile.mkdtemp()))
    agent = make_agent(budget_cents=100)
    store.agents[agent.id] = agent
    try:
        assert_stage_budget(store, agent, pending_cents=80)  # 100-0-80 = 20 < 25
        raise AssertionError("expected AgentRunBlockedError")
    except AgentRunBlockedError:
        pass


# --- Trust checks (lib/agents.ts runTrustChecks) ------------------------------------


def test_trust_defaults_score_100():
    d = AGENT_DEFAULTS["developer"]
    scan = run_trust_checks("developer", d["instructions"], d["skills"], d["budget_cents"])
    assert scan["score"] == 100, f"score {scan['score']}, findings: {scan['findings']}"


def test_trust_weak_instructions_flagged():
    scan = run_trust_checks("analyst", "Be helpful.", ["unit-testing"], 200_000)
    assert scan["score"] < 60
    levels = {f["title"]: f["level"] for f in scan["findings"]}
    assert levels["Clear role and workflow"] == "fail"
    assert levels["Prompt-injection guardrail"] == "fail"
    assert levels["Budget cap"] == "warn"


# --- Submit parsers (lib/agent-tools.ts) ---------------------------------------------


def test_parse_analysis_develop():
    out = parse_analysis({"decision": "develop", "summary": "s", "plan": "1. do it",
                          "acceptance_criteria": ["it works"], "files": ["src/a.py"]})
    assert out["decision"] == "develop" and out["plan"].files == ["src/a.py"]


def test_parse_analysis_needs_input():
    out = parse_analysis({"decision": "needs_input", "summary": "s", "question": "Which API?"})
    assert out["decision"] == "needs_input" and out["question"] == "Which API?"


def test_parse_analysis_rejects_bad_decision():
    try:
        parse_analysis({"decision": "maybe", "summary": "s"})
        raise AssertionError("expected SubmissionError")
    except SubmissionError:
        pass


def test_parse_review_request_changes_requires_findings():
    try:
        parse_review({"verdict": "request_changes", "summary": "s", "findings": []})
        raise AssertionError("expected SubmissionError")
    except SubmissionError:
        pass


def test_parse_verification_fail_requires_problems():
    try:
        parse_verification({"passed": False, "report": "r", "problems": []})
        raise AssertionError("expected SubmissionError")
    except SubmissionError:
        pass


def test_submission_box_accepts_exactly_one():
    box = SubmissionBox()
    assert box.set({"a": 1}) == "Submitted."
    try:
        box.set({"a": 2})
        raise AssertionError("expected SubmissionError")
    except SubmissionError as exc:
        assert "already submitted" in str(exc)


# --- Repository rules (lib/github-repo.ts) --------------------------------------------


def _scratch_repo(tmp: Path) -> LocalRepo:
    store, repo = fresh_workspace(tmp)
    return repo


def test_write_refused_on_default_branch():
    with tempfile.TemporaryDirectory() as d:
        repo = _scratch_repo(Path(d))
        try:
            repo.write_file("main", "src/new.py", "x = 1", "add")
            raise AssertionError("expected RepoError")
        except RepoError:
            pass


def test_protected_paths_refused():
    with tempfile.TemporaryDirectory() as d:
        repo = _scratch_repo(Path(d))
        assert repo.create_branch("feat/x", "main")
        for bad in (".env", ".env.local", ".github/workflows/ci.yml"):
            try:
                repo.write_file("feat/x", bad, "secret=1", "add")
                raise AssertionError(f"expected ProtectedPathError for {bad}")
            except Exception as exc:
                assert "protected" in str(exc), f"{bad}: {exc}"


def test_protected_path_unit():
    assert is_protected_path(".env")
    assert is_protected_path(".env.local")
    assert is_protected_path(".github/workflows/ci.yml")
    assert not is_protected_path("src/app.py")
    assert normalize_repo_path("./src/app.py") == "src/app.py"
    assert normalize_repo_path("/src/app.py") == "src/app.py"
    assert normalize_repo_path("../evil.py") is None
    assert normalize_repo_path("src/../../evil.py") is None


def test_branch_compare_after_write():
    with tempfile.TemporaryDirectory() as d:
        repo = _scratch_repo(Path(d))
        assert repo.create_branch("feat/dc-1-add-greeting", "main")
        created = repo.write_file("feat/dc-1-add-greeting", "src/greet.py", 'GREETING = "hi"\n', "Add greeting")
        assert created
        diff = repo.compare_branches("main", "feat/dc-1-add-greeting")
        assert diff.ahead_by == 1 and diff.files[0]["filename"] == "src/greet.py"


def test_merge_conflict_raises_and_aborts():
    with tempfile.TemporaryDirectory() as d:
        repo = _scratch_repo(Path(d))
        repo.create_branch("feat/conflict", "main")
        repo.write_file("feat/conflict", "README.md", "# CHANGED ON BRANCH\n", "change readme")
        repo._checkout("main")
        (repo.path / "README.md").write_text("# CHANGED ON MAIN\n", encoding="utf-8")
        repo._git("add", "README.md")
        repo._git("commit", "-m", "Change readme on main")
        try:
            repo.merge("feat/conflict")
            raise AssertionError("expected RepoError")
        except RepoError:
            pass
        assert repo._current_branch() == "main"


def test_sample_repo_reseeding_is_idempotent():
    """The UI's Reset re-creates a workspace over the same checkout: seeding an
    already-seeded repo must not fail on an empty commit."""
    from devcrew.factory import create_sample_repo
    with tempfile.TemporaryDirectory() as d:
        repo = create_sample_repo(Path(d) / "repo")
        head_before = repo._git("rev-parse", "HEAD").strip()
        create_sample_repo(Path(d) / "repo")  # again: no changes, no new commit
        head_after = repo._git("rev-parse", "HEAD").strip()
        assert head_before == head_after
        # And a dirty checkout gets restored and recommitted.
        (repo.path / "src" / "tasks.py").write_text("# scribbled\n", encoding="utf-8")
        create_sample_repo(Path(d) / "repo")
        assert repo.read_file("main", "src/tasks.py").startswith('"""In-memory task store."""')


# --- Pipeline integration with the scripted model -------------------------------------


def happy_path_model() -> ScriptedChatModel:
    """Analyst explores then plans; Developer writes; Reviewer approves; Tester passes."""
    return ScriptedChatModel(steps=[
        # analysis (Analyst)
        {"tool_calls": [{"name": "list_files", "args": {}}]},
        {"tool_calls": [{"name": "read_file", "args": {"path": "src/tasks.py"}}]},
        {"tool_calls": [{"name": "submit_analysis", "args": {
            "decision": "develop",
            "summary": "Add a done-flag to tasks.",
            "plan": "1. Extend src/tasks.py with a done flag.",
            "acceptance_criteria": '["Tasks can be marked done"]',
            "files": '["src/tasks.py"]'}}]},
        # development (Developer)
        {"tool_calls": [{"name": "write_file", "args": {
            "path": "src/tasks.py",
            "content": '"""In-memory task store."""\n\n_tasks: list[dict] = []\n\n\ndef add_task(title: str) -> None:\n    _tasks.append({"title": title, "done": False})\n\n\ndef list_tasks() -> list[dict]:\n    return list(_tasks)\n',
            "commit_message": "Add done flag to tasks"}}]},
        {"tool_calls": [{"name": "get_diff", "args": {}}]},
        {"tool_calls": [{"name": "submit_work", "args": {
            "summary": "Added a done flag to each task."}}]},
        # review (Reviewer)
        {"tool_calls": [{"name": "get_diff", "args": {}}]},
        {"tool_calls": [{"name": "submit_review", "args": {
            "verdict": "approve", "summary": "Clean, meets the criteria.", "findings": "[]"}}]},
        # testing (Tester)
        {"tool_calls": [{"name": "get_diff", "args": {}}]},
        {"tool_calls": [{"name": "submit_verification", "args": {
            "passed": True, "report": "Branch has commits; planned file changed; nothing protected.", "problems": "[]"}}]},
    ])


def test_end_to_end_manual_merge():
    with tempfile.TemporaryDirectory() as d:
        store, repo = fresh_workspace(Path(d))
        task = add_task(store, "Add a done flag to tasks",
                        "Users want to mark tasks complete.", type="feature")
        err = start_task_run(store, repo, task, happy_path_model(), "scripted-chat-model")
        assert err is None, err

        run = store.run_for_task(task.id)
        assert run.status == "done", f"run status {run.status}: {run.error}"
        # Manual merge: the run is done, the PR waits open, and the board card
        # stays in the Testing column (the user reviews and merges the PR).
        assert task.agent_run_status == "done"
        assert task.status == "testing"
        pr = store.latest_pr_for_run(run.id)
        assert pr is not None and pr.state == "open"
        assert pr.changed_files == 1
        # Manual merge mode: the branch is not merged yet.
        diff = repo.compare_branches("main", run.branch)
        assert diff.ahead_by == 1
        # Every agent recorded spend.
        spenders = {store.agents[e.agent_id].role for e in store.activities if e.cost_cents > 0}
        assert spenders == {"analyst", "developer", "reviewer", "tester"}


def test_end_to_end_auto_merge():
    with tempfile.TemporaryDirectory() as d:
        store, repo = fresh_workspace(Path(d), merge_mode="auto")
        task = add_task(store, "Add a done flag to tasks", "Mark tasks complete.")
        err = start_task_run(store, repo, task, happy_path_model(), "scripted-chat-model")
        assert err is None, err
        run = store.run_for_task(task.id)
        assert run.status == "done", f"run status {run.status}: {run.error}"
        pr = store.latest_pr_for_run(run.id)
        assert pr.state == "merged" and pr.merged_by == "auto"
        diff = repo.compare_branches("main", run.branch)
        assert diff.ahead_by == 0, "branch should be merged into main"


def test_rework_round_then_approval():
    with tempfile.TemporaryDirectory() as d:
        store, repo = fresh_workspace(Path(d))
        task = add_task(store, "Add a done flag", "Mark tasks complete.")
        model = ScriptedChatModel(steps=[
            {"tool_calls": [{"name": "submit_analysis", "args": {
                "decision": "develop", "summary": "s", "plan": "1. change code",
                "acceptance_criteria": '["it works"]', "files": '["src/tasks.py"]'}}]},
            {"tool_calls": [{"name": "write_file", "args": {
                "path": "src/tasks.py", "content": "# v1\n", "commit_message": "v1"}}]},
            {"tool_calls": [{"name": "submit_work", "args": {"summary": "v1 done"}}]},
            # review: request changes
            {"tool_calls": [{"name": "submit_review", "args": {
                "verdict": "request_changes", "summary": "Missing tests.",
                "findings": '[{"severity": "blocking", "file": "src/tasks.py", "comment": "Add tests."}]'}}]},
            # development round 1: fix and resubmit
            {"tool_calls": [{"name": "write_file", "args": {
                "path": "tests/test_tasks.py", "content": "# tests\n", "commit_message": "Add tests"}}]},
            {"tool_calls": [{"name": "submit_work", "args": {"summary": "fixed"}}]},
            # review: approve
            {"tool_calls": [{"name": "submit_review", "args": {
                "verdict": "approve", "summary": "Good now.", "findings": "[]"}}]},
            # testing: pass
            {"tool_calls": [{"name": "submit_verification", "args": {
                "passed": True, "report": "all good", "problems": "[]"}}]},
        ])
        err = start_task_run(store, repo, task, model, "scripted-chat-model")
        assert err is None, err
        run = store.run_for_task(task.id)
        assert run.status == "done", f"run status {run.status}: {run.error}"
        assert run.round == 1
        titles = [e.title for e in store.activities]
        assert any("Requested changes" in t for t in titles)


def test_rework_exhaustion_fails_run():
    with tempfile.TemporaryDirectory() as d:
        store, repo = fresh_workspace(Path(d))
        task = add_task(store, "Add a done flag", "desc")

        def review_fail(_messages):
            return {"tool_calls": [{"name": "submit_review", "args": {
                "verdict": "request_changes", "summary": "Still broken.",
                "findings": '[{"severity": "blocking", "comment": "Fix it."}]'}}]}

        def dev_fix(_messages):
            return {"tool_calls": [{"name": "write_file", "args": {
                "path": "src/tasks.py", "content": "# v\n", "commit_message": "work"}}]}

        def dev_submit(_messages):
            return {"tool_calls": [{"name": "submit_work", "args": {"summary": "done"}}]}

        steps = [
            {"tool_calls": [{"name": "submit_analysis", "args": {
                "decision": "develop", "summary": "s", "plan": "1. code",
                "acceptance_criteria": '["works"]', "files": '["src/tasks.py"]'}}]},
            dev_fix, dev_submit, review_fail,   # round 0 -> round 1
            dev_fix, dev_submit, review_fail,   # round 1 -> round 2
            dev_fix, dev_submit, review_fail,   # round 2 >= MAX_REWORK_ROUNDS -> failed
        ]
        model = ScriptedChatModel(steps=steps)
        err = start_task_run(store, repo, task, model, "scripted-chat-model")
        assert err is None, err
        run = store.run_for_task(task.id)
        assert run.status == "failed"
        assert "after 2 rounds" in (run.error or ""), run.error
        assert task.agent_run_status == "failed"


def test_needs_input_finishes_as_needs_input():
    with tempfile.TemporaryDirectory() as d:
        store, repo = fresh_workspace(Path(d))
        task = add_task(store, "Add SSO login", "desc")
        model = ScriptedChatModel(steps=[
            {"tool_calls": [{"name": "submit_analysis", "args": {
                "decision": "needs_input", "summary": "s", "question": "Which identity provider?"}}]},
        ])
        err = start_task_run(store, repo, task, model, "scripted-chat-model")
        assert err is None, err
        run = store.run_for_task(task.id)
        assert run.status == "needs_input"
        assert "identity provider" in (run.error or "")
        assert task.status == "todo" and task.agent_run_status == "done"


def test_max_turns_without_submission_fails():
    with tempfile.TemporaryDirectory() as d:
        store, repo = fresh_workspace(Path(d))
        task = add_task(store, "Add a done flag", "desc")
        store.agent_by_role("analyst").max_turns = 3
        model = ScriptedChatModel(steps=[
            {"tool_calls": [{"name": "list_files", "args": {}}]},
            {"tool_calls": [{"name": "read_file", "args": {"path": "README.md"}}]},
            {"text": "still thinking"},
        ])
        err = start_task_run(store, repo, task, model, "scripted-chat-model")
        assert err is None, err
        run = store.run_for_task(task.id)
        assert run.status == "failed", f"expected failed, got {run.status}"
        assert "used all 3 turns" in (run.error or ""), run.error


def test_budget_gate_blocks_pipeline_start():
    with tempfile.TemporaryDirectory() as d:
        store, repo = fresh_workspace(Path(d))
        store.agent_by_role("analyst").budget_cents = 30
        record_agent_spend(store, store.agent_by_role("analyst").id,
                           "task_completed", "earlier", None, cost_cents=20)
        task = add_task(store, "Anything", "desc")
        err = start_task_run(store, repo, task, happy_path_model(), "scripted-chat-model")
        assert err is not None and "monthly budget" in err


def test_branch_checks_missing_branch():
    with tempfile.TemporaryDirectory() as d:
        store, repo = fresh_workspace(Path(d))
        task = add_task(store, "x", "y")
        run = TaskRun(id="r1", workspace_id=store.workspace_id, task_id=task.id, branch="feat/gone")
        checks = branch_checks(store, repo, run)
        by_title = {c["title"]: c for c in checks}
        assert by_title["Branch exists"]["ok"] is False


def test_merge_conflict_files_follow_up_task():
    """Merge stage in isolation: an open PR whose branch conflicts with main
    fails the run and files a follow-up task in the Todo column."""
    with tempfile.TemporaryDirectory() as d:
        store, repo = fresh_workspace(Path(d), merge_mode="auto")
        task = add_task(store, "Conflicting change", "desc")

        # Craft the run exactly where the pipeline leaves it after testing passes.
        run = TaskRun(id=store.new_id(), workspace_id=store.workspace_id, task_id=task.id,
                      stage="merge", branch="feat/dc-1-conflicting-change")
        store.runs[run.id] = run
        repo.create_branch(run.branch, "main")
        repo.write_file(run.branch, "src/tasks.py", "# BRANCH VERSION\n", "Branch change")

        # Now main moves with a different version of the same file.
        repo._checkout("main")
        (repo.path / "src" / "tasks.py").write_text("# MAIN VERSION\n", encoding="utf-8")
        repo._git("add", "src/tasks.py")
        repo._git("commit", "-m", "Change tasks.py on main")

        pull_request_stage(store, repo, run)   # records the PR artifact, -> merge
        assert run.stage == "merge"
        merge_stage(store, repo, run)

        assert run.status == "failed"
        pr = store.latest_pr_for_run(run.id)
        assert pr.merge_block == "conflict"
        followups = [t for t in store.tasks.values() if t.number != task.number]
        assert len(followups) == 1 and followups[0].status == "todo"
        assert followups[0].title.startswith("Resolve merge conflicts")


def test_run_branch_naming_and_collision_suffix():
    with tempfile.TemporaryDirectory() as d:
        store, repo = fresh_workspace(Path(d))
        task = add_task(store, "Add a done flag to tasks!", "desc", type="bug")
        run = TaskRun(id="abcdef123456", workspace_id=store.workspace_id, task_id=task.id)
        name = create_run_branch(store, repo, run)
        assert name == "fix/dc-1-add-a-done-flag-to-tasks", name
        # A second run of the same task gets its id as a suffix.
        run2 = TaskRun(id="fedcba654321", workspace_id=store.workspace_id, task_id=task.id)
        name2 = create_run_branch(store, repo, run2)
        assert name2 == "fix/dc-1-add-a-done-flag-to-tasks-fedcba", name2


# --- Runner ---------------------------------------------------------------------------

ALL_TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]

if __name__ == "__main__":
    print(f"Running {len(ALL_TESTS)} offline tests (no network)...\n")
    for fn in ALL_TESTS:
        check(fn.__name__, fn)
    print(f"\n{'=' * 50}")
    print(f"RESULT: {PASS}/{PASS + FAIL} green" + (f" -- FAILURES: {FAILURES}" if FAILURES else ""))
    sys.exit(0 if FAIL == 0 else 1)
