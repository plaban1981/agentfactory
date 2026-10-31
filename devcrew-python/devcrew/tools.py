"""Function tools the AI team uses on a task run, ported from lib/agent-tools.ts.

They act on the workspace's repository through the LocalRepo backend:
reads come from `ref`, and writes only ever go to the run's own branch, never
to the default branch. Submit calls are validated here; a bad one goes back to
the agent as an error instead of ending the stage.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Optional, Union

from langchain_core.tools import tool

from .repo import LocalRepo, ProtectedPathError, RepoError, normalize_repo_path
from .state import AnalystPlan, ReviewResult

MAX_LISTED_FILES = 400
MAX_READ_CHARS = 60_000
MAX_DIFF_CHARS = 80_000


@dataclass
class ToolContext:
    """Where reads come from and where writes go, for one stage of one run."""
    repo: LocalRepo
    ref: str            # default branch while analyzing, the run's branch after that
    base_branch: str
    branch: Optional[str]   # the run's branch; None until development starts


# --- Output truncation helpers (same limits as the original) ------------------

def truncated(text: str, max_chars: int) -> str:
    if len(text) > max_chars:
        return f"{text[:max_chars]}\n... (truncated, {len(text) - max_chars} more characters)"
    return text


def _text(value: Any, max_len: int) -> str:
    return value.strip()[:max_len] if isinstance(value, str) else ""


def _string_list(value: Any, max_items: int, max_length: int) -> list[str]:
    if not isinstance(value, list):
        return []
    return [s for s in (_text(item, max_length) for item in value) if s][:max_items]


# --- Repo tools ----------------------------------------------------------------

def make_repo_tools(ctx: ToolContext) -> list[Callable]:
    """Builds the five repository tools bound to one ToolContext (per run, per stage)."""

    @tool
    def list_files(path_prefix: str = "", contains: str = "") -> str:
        """List files in the repository. Filter by a folder prefix and/or a case-insensitive substring of the path.

        Args:
            path_prefix: Only files under this folder, e.g. "app/dashboard".
            contains: Only paths containing this text, e.g. "button".
        """
        prefix = _text(path_prefix, 300).lstrip("./").rstrip("/")
        needle = _text(contains, 100).lower()
        entries = ctx.repo.list_files(ctx.ref)
        matches = [
            e for e in entries
            if (not prefix or e.path == prefix or e.path.startswith(prefix + "/"))
            and (not needle or needle in e.path.lower())
        ]
        if not matches:
            return "No files match."
        lines = [f"{e.path} ({e.size} B)" for e in matches[:MAX_LISTED_FILES]]
        more = len(matches) - len(lines)
        if more > 0:
            lines.append(f"... and {more} more. Narrow it down with path_prefix or contains.")
        return "\n".join(lines)

    @tool
    def read_file(path: str, start_line: int = 1, end_line: int = 0) -> str:
        """Read a text file from the repository, with line numbers. Use start_line and end_line for large files.

        Args:
            path: Repository-relative path.
            start_line: First line to show (1-based).
            end_line: Last line to show (0 = to end of file).
        """
        p = normalize_repo_path(path)
        if not p:
            return 'Error: give a repository-relative path such as "src/index.ts".'
        content = ctx.repo.read_file(ctx.ref, p)
        if content is None:
            return f"Error: {p} doesn't exist on {ctx.ref}. Use list_files to find the right path."
        if "\x00" in content:
            return f"{p} is a binary file ({len(content)} B)."
        lines = content.split("\n")
        start = max(1, int(start_line) if start_line else 1)
        end = min(len(lines), int(end_line) if end_line else len(lines))
        numbered = "\n".join(f"{start + i}\t{line}" for i, line in enumerate(lines[start - 1:end]))
        return truncated(f"{p} (lines {start}-{end} of {len(lines)})\n{numbered}", MAX_READ_CHARS)

    @tool
    def get_diff() -> str:
        """Show the commits and the unified diff of the run's branch compared with the default branch."""
        if not ctx.branch:
            return "Error: there is no branch for this run yet."
        diff = ctx.repo.compare_branches(ctx.base_branch, ctx.branch)
        if diff.ahead_by == 0:
            return f"{ctx.branch} has no commits ahead of {ctx.base_branch} yet."
        commits = "\n".join(f"- {c['sha'][:7]} {c['message'].splitlines()[0]}" for c in diff.commits)
        file_blocks = []
        for f in diff.files:
            patch = ctx.repo.file_patch(ctx.base_branch, ctx.branch, f["filename"]) or "(no textual diff)"
            file_blocks.append(
                f"### {f['filename']} ({f['status']}, +{f['additions']} -{f['deletions']})\n{patch}"
            )
        return truncated(
            f"{diff.ahead_by} commits on {ctx.branch}:\n{commits}\n\n{len(diff.files)} files changed:\n\n"
            + "\n\n".join(file_blocks),
            MAX_DIFF_CHARS,
        )

    @tool
    def write_file(path: str, content: str, commit_message: str) -> str:
        """Create or replace a file on the run's branch with its complete new content. Each call is one commit.

        Args:
            path: Repository-relative path.
            content: The full file content, not a patch.
            commit_message: Imperative mood, under 72 characters.
        """
        return _write_tool(ctx, "write_file", path, content, commit_message)

    @tool
    def delete_file(path: str, commit_message: str) -> str:
        """Delete a file on the run's branch. Each call is one commit.

        Args:
            path: Repository-relative path.
            commit_message: Imperative mood, under 72 characters.
        """
        return _write_tool(ctx, "delete_file", path, None, commit_message)

    return [list_files, read_file, get_diff, write_file, delete_file]


def _write_tool(ctx: ToolContext, name: str, path: str, content: Optional[str], message: str) -> str:
    if not ctx.branch or ctx.branch == ctx.base_branch:
        return "Error: you can only change files on the run's feature branch."
    p = normalize_repo_path(path or "")
    if not p:
        return 'Error: give a repository-relative path such as "src/index.ts".'
    msg = _text(message, 200) or f"Update {p}"
    try:
        if name == "delete_file":
            deleted = ctx.repo.delete_file(ctx.branch, p, msg)
            return f"Deleted {p}." if deleted else f"{p} doesn't exist, so nothing was deleted."
        if not isinstance(content, str):
            return "Error: content must be the file's full text."
        created = ctx.repo.write_file(ctx.branch, p, content, msg)
        verb = "Created" if created else "Updated"
        return f"{verb} {p} ({len(content.splitlines())} lines)."
    except ProtectedPathError as exc:
        return f"Error: {exc}"
    except RepoError as exc:
        return f"Error: {exc}"


# --- Submission box -------------------------------------------------------------

class SubmissionError(Exception):
    """Raised by submit tools to send a validation error back to the agent."""


class SubmissionBox:
    """Holds at most one validated submission per stage, exactly like the
    original turn loop reading the submit_* tool call."""

    def __init__(self):
        self.outcome: Optional[dict] = None

    def set(self, outcome: dict) -> str:
        if self.outcome is not None:
            raise SubmissionError("You already submitted.")
        self.outcome = outcome
        return "Submitted."


def make_submit_tools(stage: str, box: SubmissionBox,
                      validator: Optional[Callable[[dict], None]] = None) -> tuple[list[Callable], str]:
    """Builds the stage's submit tool. Returns (tools, submit_tool_name).

    `validator` mirrors parseSubmission() in lib/task-runs.ts: it inspects the
    parsed submission and raises SubmissionError to send an error back to the
    agent instead of ending the stage."""

    def hand_in(outcome: dict) -> str:
        if validator is not None:
            validator(outcome)
        box.set(outcome)
        return ("Submitted. Your work is handed in for this stage: do not call any "
                "more tools, and end with a brief closing message.")

    if stage == "analysis":

        @tool
        def submit_analysis(decision: str, summary: str, plan: str = "",
                            acceptance_criteria: str = "[]", files: str = "[]",
                            question: str = "") -> str:
            """Hand in your analysis. Call it exactly once, when you are done.

            Args:
                decision: "develop" to assign the task to the Developer; "needs_input" when a person must answer a question first.
                summary: One or two sentences on what the task needs.
                plan: Markdown implementation plan for the Developer, step by step.
                acceptance_criteria: JSON array of strings.
                files: JSON array of files likely to change.
                question: Required with needs_input: the one question a person must answer.
            """
            outcome = parse_analysis({
                "decision": decision, "summary": summary, "plan": plan,
                "acceptance_criteria": json.loads(acceptance_criteria or "[]"),
                "files": json.loads(files or "[]"), "question": question,
            })
            return box.set(outcome)

        return [submit_analysis], "submit_analysis"

    if stage == "development":

        @tool
        def submit_work(summary: str, notes_for_reviewer: str = "") -> str:
            """Hand your committed changes to the Reviewer. Call it once every acceptance criterion is met.

            Args:
                summary: What changed and why, in Markdown.
                notes_for_reviewer: Anything the Reviewer should look at closely.
            """
            outcome = parse_work({"summary": summary, "notes_for_reviewer": notes_for_reviewer})
            return hand_in(outcome)

        return [submit_work], "submit_work"

    if stage == "review":

        @tool
        def submit_review(verdict: str, summary: str, findings: str = "[]") -> str:
            """Hand in your review. Call it exactly once.

            Args:
                verdict: "approve" or "request_changes".
                summary: Overall assessment.
                findings: JSON array of {"severity": "blocking|should_fix|nit", "file": "optional", "comment": "..."}.
            """
            outcome = parse_review({"verdict": verdict, "summary": summary, "findings": json.loads(findings or "[]")})
            return hand_in(outcome)

        return [submit_review], "submit_review"

    # testing

    @tool
    def submit_verification(passed: bool, report: str, problems: str = "[]") -> str:
        """Hand in your verification. Call it exactly once.

        Args:
            passed: True when the changes are in the right files and the branch is ready for a pull request.
            report: Markdown report: what you checked, per acceptance criterion.
            problems: JSON array of strings: what the Developer must fix when passed is false.
        """
        outcome = parse_verification({"passed": passed, "report": report, "problems": json.loads(problems or "[]")})
        return hand_in(outcome)

    return [submit_verification], "submit_verification"


# --- Submit-call validation (ported verbatim from the parsers in agent-tools.ts) --

def parse_analysis(args: dict) -> Union[dict, Any]:
    summary = _text(args.get("summary"), 1000)
    if not summary:
        raise SubmissionError("Add a summary.")
    if args.get("decision") == "needs_input":
        question = _text(args.get("question"), 1000)
        if not question:
            raise SubmissionError("With needs_input, ask the one question a person must answer.")
        return {"decision": "needs_input", "summary": summary, "question": question}
    if args.get("decision") != "develop":
        raise SubmissionError('decision must be "develop" or "needs_input".')
    plan = _text(args.get("plan"), 12_000)
    acceptance = _string_list(args.get("acceptance_criteria"), 20, 500)
    if not plan or not acceptance:
        raise SubmissionError("A develop decision needs a plan and at least one acceptance criterion.")
    return {
        "decision": "develop",
        "plan": AnalystPlan(summary=summary, plan=plan, acceptance_criteria=acceptance,
                            files=_string_list(args.get("files"), 40, 300)),
    }


def parse_work(args: dict) -> dict:
    summary = _text(args.get("summary"), 6000)
    if not summary:
        raise SubmissionError("Add a summary of your changes.")
    notes = _text(args.get("notes_for_reviewer"), 3000)
    return {"summary": f"{summary}\n\n**Notes for the reviewer:** {notes}" if notes else summary}


def parse_review(args: dict) -> ReviewResult:
    if args.get("verdict") not in ("approve", "request_changes"):
        raise SubmissionError("verdict must be approve or request_changes.")
    summary = _text(args.get("summary"), 4000)
    if not summary:
        raise SubmissionError("Add a summary.")
    findings = []
    for f in (args.get("findings") or [])[:30]:
        if not isinstance(f, dict):
            continue
        body = _text(f.get("comment"), 1500)
        if not body:
            continue
        severity = f.get("severity")
        findings.append({
            "severity": severity if severity in ("blocking", "nit") else "should_fix",
            "file": _text(f.get("file"), 300) or None,
            "comment": body,
        })
    if args.get("verdict") == "request_changes" and not findings:
        raise SubmissionError("List at least one finding when you request changes.")
    return ReviewResult(verdict=args["verdict"], summary=summary, findings=findings)


def parse_verification(args: dict) -> dict:
    if not isinstance(args.get("passed"), bool):
        raise SubmissionError("passed must be true or false.")
    report = _text(args.get("report"), 6000)
    if not report:
        raise SubmissionError("Add a report.")
    problems = _string_list(args.get("problems"), 20, 1000)
    if not args["passed"] and not problems:
        raise SubmissionError("List what the Developer must fix.")
    return {"passed": args["passed"], "report": report, "problems": problems}


# --- Stage wiring ----------------------------------------------------------------

def stage_tools(stage: str, ctx: ToolContext, box: SubmissionBox,
                validator: Optional[Callable[[dict], None]] = None) -> tuple[list[Callable], str]:
    """The full tool list for a stage: repo tools plus the stage's submit tool."""
    repo_tools = make_repo_tools(ctx)
    submit_tools, submit_name = make_submit_tools(stage, box, validator=validator)
    # Same per-stage subsets as STAGE_TOOLS in the original.
    if stage == "analysis":
        repo_subset = [repo_tools[0], repo_tools[1]]                       # list_files, read_file
    elif stage == "development":
        repo_subset = repo_tools                                            # all five
    else:  # review, testing
        repo_subset = [repo_tools[2], repo_tools[0], repo_tools[1]]        # get_diff, list_files, read_file
    return repo_subset + submit_tools, submit_name


# What a stage's tools tell the agent about how this run works, appended to its
# own instructions. Ported verbatim from STAGE_BRIEFS in agent-tools.ts.
STAGE_BRIEFS: dict[str, str] = {
    "analysis": """You are working one task through DevCrew's pipeline: you analyze it, the Developer implements it on a feature branch, the Reviewer reviews it and the Tester verifies it and opens the pull request.
Explore the repository with list_files and read_file (they read the default branch), then call submit_analysis. Choose "develop" whenever the task can be built from what you know, stating your assumptions in the plan. Choose "needs_input" only when a wrong guess would waste the whole run.""",
    "development": """You are implementing one task in DevCrew's pipeline. A branch was created for you from the default branch; write_file and delete_file commit to it, and list_files and read_file read from it. There is no shell: you can't run builds or tests, so read the surrounding code carefully and keep the change consistent with it.
Write complete file contents, never placeholders. When every acceptance criterion is met, review your work with get_diff, then call submit_work.""",
    "review": """You are reviewing one task's branch in DevCrew's pipeline before the Tester verifies it. Read the diff with get_diff and the surrounding code with read_file. Request changes only for real problems: bugs, security issues, missed acceptance criteria or clear convention breaks. Then call submit_review.""",
    "testing": """You are verifying one task's branch in DevCrew's pipeline. Don't run tests. Check that the branch exists with commits, that the changes are in the right files for the plan, that nothing unrelated changed and that the files are complete. DevCrew's own branch checks are included below. Then call submit_verification. When you pass it, DevCrew opens the pull request for you.""",
}

STAGE_FINAL_INSTRUCTIONS: dict[str, str] = {
    "analysis": "Analyze this task, then call submit_analysis.",
    "development": "Implement the task on the branch, then call submit_work.",
    "review": "Review the branch, then call submit_review.",
    "testing": "Verify the branch, then call submit_verification.",
}
