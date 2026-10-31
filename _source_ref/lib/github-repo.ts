import "server-only";

import { GithubApiError, githubFetch } from "@/lib/github";

// Repository operations the AI team runs: branches, files, diffs, pull requests and checks.
// Every path goes through /repositories/{id}, so a renamed or transferred repository keeps working.

// Agents may not change CI or commit environment files; DevCrew refuses these writes outright.
const PROTECTED_PATHS = [/^\.github\/workflows\//i, /(^|\/)\.env(\.|$)/i];
const MAX_FILE_BYTES = 400_000;

export function isProtectedPath(path: string) {
  return PROTECTED_PATHS.some((pattern) => pattern.test(path));
}

// Repository-relative path with no leading slash, empty segments or "..".
export function normalizeRepoPath(path: unknown): string | null {
  if (typeof path !== "string") return null;
  const clean = path.trim().replace(/^\.?\/+/, "");
  if (!clean || clean.length > 400 || clean.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  return clean;
}

function encodePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function refPath(branch: string) {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function isStatus(error: unknown, ...statuses: number[]) {
  return error instanceof GithubApiError && statuses.includes(error.status);
}

export async function getBranchSha(token: string, repoId: number, branch: string): Promise<string | null> {
  try {
    const ref = await githubFetch<{ object: { sha: string } }>(token, `/repositories/${repoId}/git/ref/heads/${refPath(branch)}`);
    return ref.object.sha;
  } catch (error) {
    if (isStatus(error, 404)) return null;
    throw error;
  }
}

// Creates `branch` from the tip of `base`. Returns false when the branch already exists.
export async function createBranch(token: string, repoId: number, branch: string, base: string): Promise<boolean> {
  const sha = await getBranchSha(token, repoId, base);
  if (!sha) throw new GithubApiError(404, `branch ${base}`, `The base branch ${base} doesn't exist.`);
  try {
    await githubFetch(token, `/repositories/${repoId}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    });
    return true;
  } catch (error) {
    if (isStatus(error, 422)) return false;
    throw error;
  }
}

export type TreeEntry = { path: string; size: number };

// Every file on the branch. GitHub caps recursive trees at about 100,000 entries.
export async function listTree(token: string, repoId: number, branch: string): Promise<{ files: TreeEntry[]; truncated: boolean }> {
  const tree = await githubFetch<{ tree: { path: string; type: string; size?: number }[]; truncated: boolean }>(
    token,
    `/repositories/${repoId}/git/trees/${refPath(branch)}?recursive=1`,
  );
  return {
    files: tree.tree.filter((entry) => entry.type === "blob").map((entry) => ({ path: entry.path, size: entry.size ?? 0 })),
    truncated: tree.truncated,
  };
}

type ApiContent = { type: string; sha: string; size: number; encoding?: string; content?: string };

export async function readFile(
  token: string,
  repoId: number,
  branch: string,
  path: string,
): Promise<{ content: string; sha: string; size: number } | null> {
  let file: ApiContent | ApiContent[];
  try {
    file = await githubFetch<ApiContent | ApiContent[]>(
      token,
      `/repositories/${repoId}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
    );
  } catch (error) {
    if (isStatus(error, 404)) return null;
    throw error;
  }
  if (Array.isArray(file) || file.type !== "file") return null;
  const content = file.encoding === "base64" && file.content ? Buffer.from(file.content, "base64").toString("utf8") : "";
  return { content, sha: file.sha, size: file.size };
}

// Creates or replaces a file with one commit on `branch`. Looks up the current sha first, so a retry is harmless.
export async function writeFile(token: string, repoId: number, branch: string, path: string, content: string, message: string) {
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Error(`Files over ${MAX_FILE_BYTES / 1000} KB can't be written.`);
  const existing = await readFile(token, repoId, branch, path);
  await githubFetch(token, `/repositories/${repoId}/contents/${encodePath(path)}`, {
    method: "PUT",
    body: JSON.stringify({ message, content: Buffer.from(content, "utf8").toString("base64"), branch, sha: existing?.sha }),
  });
  return { created: !existing };
}

export async function deleteFile(token: string, repoId: number, branch: string, path: string, message: string) {
  const existing = await readFile(token, repoId, branch, path);
  if (!existing) return { deleted: false };
  await githubFetch(token, `/repositories/${repoId}/contents/${encodePath(path)}`, {
    method: "DELETE",
    body: JSON.stringify({ message, sha: existing.sha, branch }),
  });
  return { deleted: true };
}

export type BranchDiff = {
  aheadBy: number;
  behindBy: number;
  commits: { sha: string; message: string }[];
  files: { filename: string; status: string; additions: number; deletions: number; patch?: string }[];
};

export async function compareBranches(token: string, repoId: number, base: string, head: string): Promise<BranchDiff> {
  const diff = await githubFetch<{
    ahead_by: number;
    behind_by: number;
    commits: { sha: string; commit: { message: string } }[];
    files?: BranchDiff["files"];
  }>(token, `/repositories/${repoId}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  return {
    aheadBy: diff.ahead_by,
    behindBy: diff.behind_by,
    commits: diff.commits.map((commit) => ({ sha: commit.sha, message: commit.commit.message })),
    files: (diff.files ?? []).map(({ filename, status, additions, deletions, patch }) => ({ filename, status, additions, deletions, patch })),
  };
}

type ApiPull = {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  mergeable: boolean | null;
  mergeable_state: string;
  changed_files: number;
  additions: number;
  deletions: number;
  head: { sha: string; ref: string };
};

export type GithubPull = {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  // null while GitHub is still computing it
  mergeable: boolean | null;
  mergeableState: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  headSha: string;
};

function toPull(pull: ApiPull): GithubPull {
  return {
    number: pull.number,
    url: pull.html_url,
    state: pull.state,
    merged: pull.merged,
    mergedAt: pull.merged_at,
    mergeCommitSha: pull.merge_commit_sha,
    mergeable: pull.mergeable,
    mergeableState: pull.mergeable_state,
    changedFiles: pull.changed_files,
    additions: pull.additions,
    deletions: pull.deletions,
    headSha: pull.head.sha,
  };
}

export async function getPull(token: string, repoId: number, number: number): Promise<GithubPull> {
  return toPull(await githubFetch<ApiPull>(token, `/repositories/${repoId}/pulls/${number}`));
}

// Opens a pull request, or returns the open one that already exists for `head`.
export async function createPull(
  token: string,
  repoId: number,
  input: { owner: string; title: string; body: string; head: string; base: string },
): Promise<GithubPull> {
  try {
    const pull = await githubFetch<ApiPull>(token, `/repositories/${repoId}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title: input.title, body: input.body, head: input.head, base: input.base }),
    });
    // The create response doesn't include diff stats until GitHub has computed them.
    return getPull(token, repoId, pull.number).catch(() => toPull(pull));
  } catch (error) {
    if (!isStatus(error, 422)) throw error;
    const [existing] = await githubFetch<ApiPull[]>(
      token,
      `/repositories/${repoId}/pulls?state=open&head=${encodeURIComponent(`${input.owner}:${input.head}`)}`,
    );
    if (!existing) throw error;
    return getPull(token, repoId, existing.number);
  }
}

export type MergeResult = { merged: true; sha: string } | { merged: false; status: number; message: string };

export async function mergePull(token: string, repoId: number, number: number, headSha: string, title: string): Promise<MergeResult> {
  try {
    const result = await githubFetch<{ sha: string; merged: boolean; message: string }>(token, `/repositories/${repoId}/pulls/${number}/merge`, {
      method: "PUT",
      body: JSON.stringify({ merge_method: "squash", sha: headSha, commit_title: `${title} (#${number})` }),
    });
    return result.merged ? { merged: true, sha: result.sha } : { merged: false, status: 405, message: result.message };
  } catch (error) {
    // 405: not mergeable (conflicts or branch protection); 409: the head moved since we checked; 422: invalid.
    if (error instanceof GithubApiError && [405, 409, 422].includes(error.status)) {
      return { merged: false, status: error.status, message: error.body ?? "GitHub refused the merge." };
    }
    throw error;
  }
}

export type CheckOutcome = {
  state: "success" | "pending" | "failure" | "none";
  failures: { name: string; detail: string; url: string | null }[];
  pending: string[];
};

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);

// Combines check runs (GitHub Actions and apps) with legacy commit statuses for one commit.
export async function getCheckOutcome(token: string, repoId: number, sha: string): Promise<CheckOutcome> {
  const [runs, combined] = await Promise.all([
    githubFetch<{
      check_runs: { name: string; status: string; conclusion: string | null; html_url: string | null; output?: { title?: string | null; summary?: string | null } }[];
    }>(token, `/repositories/${repoId}/commits/${sha}/check-runs?per_page=100`),
    githubFetch<{ statuses: { context: string; state: string; description: string | null; target_url: string | null }[] }>(
      token,
      `/repositories/${repoId}/commits/${sha}/status`,
    ),
  ]);

  const failures: CheckOutcome["failures"] = [];
  const pending: string[] = [];
  for (const run of runs.check_runs) {
    if (run.status !== "completed") pending.push(run.name);
    else if (run.conclusion && FAILED_CONCLUSIONS.has(run.conclusion)) {
      const detail = [run.output?.title, run.output?.summary].filter(Boolean).join(": ").slice(0, 1500);
      failures.push({ name: run.name, detail: detail || `Concluded ${run.conclusion}.`, url: run.html_url });
    }
  }
  for (const status of combined.statuses) {
    if (status.state === "pending") pending.push(status.context);
    else if (status.state === "failure" || status.state === "error") {
      failures.push({ name: status.context, detail: status.description ?? `Reported ${status.state}.`, url: status.target_url });
    }
  }

  const total = runs.check_runs.length + combined.statuses.length;
  const state = failures.length > 0 ? "failure" : pending.length > 0 ? "pending" : total > 0 ? "success" : "none";
  return { state, failures, pending };
}
