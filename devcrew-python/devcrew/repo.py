"""Repository backend: a local git checkout with the same rules as the original
GitHub API layer (lib/github-repo.ts of devcrew-yt-project).

Semantics preserved:
- writes only ever go to a feature branch, never the default branch;
- CI workflows and .env files are protected paths;
- each write/delete is one commit;
- reads can come from any ref (default branch during analysis, the run's branch after);
- compare_branches reports ahead/behind counts, commits and per-file diffs.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


class RepoError(Exception):
    pass


class ProtectedPathError(RepoError):
    pass


PROTECTED_PREFIXES = (".github/workflows", ".env")


def normalize_repo_path(path: str) -> Optional[str]:
    p = (path or "").strip().replace("\\", "/")
    while p.startswith("./"):
        p = p[2:]
    p = p.lstrip("/")
    if not p or p == "." or p.startswith("../") or "/../" in p or p == "..":
        return None
    return p


def is_protected_path(path: str) -> bool:
    p = normalize_repo_path(path) or ""
    return any(p == pref or p.startswith(pref + "/") or p.startswith(pref + ".")
               for pref in PROTECTED_PREFIXES)


@dataclass
class FileEntry:
    path: str
    size: int


@dataclass
class BranchDiff:
    ahead_by: int
    behind_by: int
    commits: list[dict] = field(default_factory=list)       # {sha, message}
    files: list[dict] = field(default_factory=list)         # {filename, status, additions, deletions, patch}
    additions: int = 0
    deletions: int = 0


class LocalRepo:
    def __init__(self, path: Path, default_branch: str = "main"):
        self.path = Path(path)
        self.default_branch = default_branch

    # -- git plumbing ---------------------------------------------------------
    def _git(self, *args: str, check: bool = True) -> str:
        result = subprocess.run(
            ["git", *args], cwd=self.path, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if check and result.returncode != 0:
            raise RepoError(result.stderr.strip() or f"git {' '.join(args)} failed")
        return result.stdout

    def init(self) -> None:
        self.path.mkdir(parents=True, exist_ok=True)
        self._git("init", "-b", self.default_branch)
        self._git("config", "user.email", "devcrew@example.local")
        self._git("config", "user.name", "DevCrew")

    def branch_exists(self, branch: str) -> bool:
        self._git("rev-parse", "--verify", "--quiet", branch, check=False)
        return subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", branch],
            cwd=self.path, capture_output=True,
        ).returncode == 0

    def create_branch(self, name: str, base: Optional[str] = None) -> bool:
        """Creates a branch from base. Returns False when the name is taken."""
        base = base or self.default_branch
        if self.branch_exists(name):
            return False
        self._git("branch", name, base)
        return True

    def list_files(self, ref: str) -> list[FileEntry]:
        out = self._git("ls-tree", "-r", "-l", ref, check=False)
        entries = []
        for line in out.splitlines():
            # 100644 blob <sha> <size>\t<path>
            meta, _, p = line.partition("\t")
            parts = meta.split()
            if len(parts) >= 4 and parts[1] == "blob":
                try:
                    size = int(parts[3])
                except ValueError:
                    size = 0
                entries.append(FileEntry(p, size))
        return entries

    def read_file(self, ref: str, path: str) -> Optional[str]:
        result = subprocess.run(
            ["git", "show", f"{ref}:{path}"],
            cwd=self.path, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if result.returncode != 0:
            return None
        return result.stdout

    def _checkout(self, branch: str) -> None:
        """Switches the shared working tree to `branch` (idempotent)."""
        if self._current_branch() != branch:
            self._git("checkout", branch)

    def write_file(self, branch: str, path: str, content: str, message: str) -> bool:
        """Creates or replaces a file on `branch` with one commit. Returns True if created."""
        self._assert_writable(branch, path)
        self._checkout(branch)
        created = self.read_file(branch, path) is None
        target = self.path / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        self._git("add", "--", path)
        self._git("commit", "-m", message or f"Update {path}")
        return created

    def delete_file(self, branch: str, path: str, message: str) -> bool:
        self._assert_writable(branch, path)
        self._checkout(branch)
        target = self.path / path
        if not target.exists():
            return False
        self._git("rm", "-q", "--", path)
        self._git("commit", "-m", message or f"Delete {path}")
        return True

    def _assert_writable(self, branch: str, path: str) -> None:
        if branch == self.default_branch:
            raise RepoError(f"you can only change files on the run's feature branch (not {branch})")
        if is_protected_path(path):
            raise ProtectedPathError(f"{path} is protected. CI workflows and .env files need a person to change them.")

    def _current_branch(self) -> str:
        return self._git("branch", "--show-current").strip()

    # -- comparisons ------------------------------------------------------------
    def compare_branches(self, base: str, branch: str) -> BranchDiff:
        ahead_by = int(self._git("rev-list", "--count", f"{base}..{branch}").strip() or 0)
        behind_by = int(self._git("rev-list", "--count", f"{branch}..{base}").strip() or 0)

        commits = []
        out = self._git("log", "--format=%H%x00%s", f"{base}..{branch}", check=False)
        for line in out.splitlines():
            if not line.strip():
                continue
            sha, _, msg = line.partition("\x00")
            commits.append({"sha": sha.strip(), "message": msg.strip()})

        files: list[dict] = []
        numstat = self._git("diff", "--numstat", f"{base}...{branch}", check=False)
        namestatus = self._git("diff", "--name-status", f"{base}...{branch}", check=False)
        status_by_path = {}
        for line in namestatus.splitlines():
            parts = line.split("\t")
            if len(parts) >= 2:
                status_by_path[parts[-1]] = parts[0]
        total_add, total_del = 0, 0
        for line in numstat.splitlines():
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            adds, dels, p = parts[0], parts[1], parts[2]
            if adds == "-":  # binary
                adds, dels = "0", "0"
            a, d = int(adds), int(dels)
            total_add += a
            total_del += d
            files.append({
                "filename": p,
                "status": status_by_path.get(p, "M"),
                "additions": a,
                "deletions": d,
                "patch": None,  # filled lazily by the diff tool when needed
            })
        return BranchDiff(ahead_by=ahead_by, behind_by=behind_by, commits=commits,
                          files=files, additions=total_add, deletions=total_del)

    def file_patch(self, base: str, branch: str, path: str) -> str:
        return self._git("diff", f"{base}...{branch}", "--", path, check=False)

    def merge(self, branch: str, into: Optional[str] = None) -> None:
        """Merges branch into the default branch (local stand-in for merging a PR)."""
        into = into or self.default_branch
        self._git("checkout", into)
        try:
            self._git("merge", "--no-ff", branch, "-m", f"Merge {branch}")
        except RepoError:
            self._git("merge", "--abort", check=False)
            self._git("checkout", into)
            raise
