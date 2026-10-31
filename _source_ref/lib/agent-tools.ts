import "server-only";

import type { FunctionTool } from "openai/resources/responses/responses";
import { GithubApiError, GithubAuthError } from "@/lib/github";
import {
  compareBranches,
  deleteFile,
  isProtectedPath,
  listTree,
  normalizeRepoPath,
  readFile,
  writeFile,
} from "@/lib/github-repo";
import type { AnalystPlan, ReviewResult, TaskRunStage } from "@/lib/workflow";

// Function tools the AI team uses on a task run. They act on the workspace's repository through the GitHub API:
// reads come from `ref`, and writes only ever go to the run's own branch, never to the default branch.

const MAX_LISTED_FILES = 400;
const MAX_READ_CHARS = 60_000;
const MAX_DIFF_CHARS = 80_000;

export type ToolContext = {
  token: string;
  repoId: number;
  // Where reads come from: the default branch while analyzing, the run's branch after that
  ref: string;
  baseBranch: string;
  // The run's branch; null until development starts
  branch: string | null;
};

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): FunctionTool {
  return { type: "function", name, description, strict: false, parameters: { type: "object", properties, required, additionalProperties: false } };
}

const LIST_FILES = tool(
  "list_files",
  "List files in the repository. Filter by a folder prefix and/or a case-insensitive substring of the path.",
  {
    path_prefix: { type: "string", description: "Only files under this folder, e.g. \"app/dashboard\"." },
    contains: { type: "string", description: "Only paths containing this text, e.g. \"button\"." },
  },
  [],
);

const READ_FILE = tool(
  "read_file",
  "Read a text file from the repository, with line numbers. Use start_line and end_line for large files.",
  {
    path: { type: "string", description: "Repository-relative path." },
    start_line: { type: "integer", minimum: 1 },
    end_line: { type: "integer", minimum: 1 },
  },
  ["path"],
);

const GET_DIFF = tool(
  "get_diff",
  "Show the commits and the unified diff of the run's branch compared with the default branch.",
  {},
  [],
);

const WRITE_FILE = tool(
  "write_file",
  "Create or replace a file on the run's branch with its complete new content. Each call is one commit.",
  {
    path: { type: "string", description: "Repository-relative path." },
    content: { type: "string", description: "The full file content, not a patch." },
    commit_message: { type: "string", description: "Imperative mood, under 72 characters." },
  },
  ["path", "content", "commit_message"],
);

const DELETE_FILE = tool(
  "delete_file",
  "Delete a file on the run's branch. Each call is one commit.",
  {
    path: { type: "string" },
    commit_message: { type: "string" },
  },
  ["path", "commit_message"],
);

export const SUBMIT_TOOLS: Record<Exclude<TaskRunStage, "pull_request" | "merge">, FunctionTool> = {
  analysis: tool(
    "submit_analysis",
    "Hand in your analysis. Call it exactly once, when you are done.",
    {
      decision: {
        type: "string",
        enum: ["develop", "needs_input"],
        description: "\"develop\" to assign the task to the Developer; \"needs_input\" when a person must answer a question first.",
      },
      summary: { type: "string", description: "One or two sentences on what the task needs." },
      plan: { type: "string", description: "Markdown implementation plan for the Developer, step by step." },
      acceptance_criteria: { type: "array", items: { type: "string" } },
      files: { type: "array", items: { type: "string" }, description: "Files likely to change." },
      question: { type: "string", description: "Required with needs_input: the one question a person must answer." },
    },
    ["decision", "summary"],
  ),
  development: tool(
    "submit_work",
    "Hand your committed changes to the Reviewer. Call it once every acceptance criterion is met.",
    {
      summary: { type: "string", description: "What changed and why, in Markdown." },
      notes_for_reviewer: { type: "string", description: "Anything the Reviewer should look at closely." },
    },
    ["summary"],
  ),
  review: tool(
    "submit_review",
    "Hand in your review. Call it exactly once.",
    {
      verdict: { type: "string", enum: ["approve", "request_changes"] },
      summary: { type: "string" },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["blocking", "should_fix", "nit"] },
            file: { type: "string" },
            comment: { type: "string" },
          },
          required: ["severity", "comment"],
        },
      },
    },
    ["verdict", "summary"],
  ),
  testing: tool(
    "submit_verification",
    "Hand in your verification. Call it exactly once.",
    {
      passed: { type: "boolean", description: "True when the changes are in the right files and the branch is ready for a pull request." },
      report: { type: "string", description: "Markdown report: what you checked, per acceptance criterion." },
      problems: { type: "array", items: { type: "string" }, description: "What the Developer must fix when passed is false." },
    },
    ["passed", "report"],
  ),
};

export const STAGE_TOOLS: Record<keyof typeof SUBMIT_TOOLS, FunctionTool[]> = {
  analysis: [LIST_FILES, READ_FILE, SUBMIT_TOOLS.analysis],
  development: [LIST_FILES, READ_FILE, GET_DIFF, WRITE_FILE, DELETE_FILE, SUBMIT_TOOLS.development],
  review: [GET_DIFF, LIST_FILES, READ_FILE, SUBMIT_TOOLS.review],
  testing: [GET_DIFF, LIST_FILES, READ_FILE, SUBMIT_TOOLS.testing],
};

// What a stage's tools tell the agent about how this run works, appended to its own instructions.
export const STAGE_BRIEFS: Record<keyof typeof SUBMIT_TOOLS, string> = {
  analysis: `You are working one task through DevCrew's pipeline: you analyze it, the Developer implements it on a feature branch, the Reviewer reviews it and the Tester verifies it and opens the pull request.
Explore the repository with list_files and read_file (they read the default branch), then call submit_analysis. Choose "develop" whenever the task can be built from what you know, stating your assumptions in the plan. Choose "needs_input" only when a wrong guess would waste the whole run.`,
  development: `You are implementing one task in DevCrew's pipeline. A branch was created for you from the default branch; write_file and delete_file commit to it, and list_files and read_file read from it. There is no shell: you can't run builds or tests, so read the surrounding code carefully and keep the change consistent with it.
Write complete file contents, never placeholders. When every acceptance criterion is met, review your work with get_diff, then call submit_work.`,
  review: `You are reviewing one task's branch in DevCrew's pipeline before the Tester verifies it. Read the diff with get_diff and the surrounding code with read_file. Request changes only for real problems: bugs, security issues, missed acceptance criteria or clear convention breaks. Then call submit_review.`,
  testing: `You are verifying one task's branch in DevCrew's pipeline. Don't run tests. Check that the branch exists with commits, that the changes are in the right files for the plan, that nothing unrelated changed and that the files are complete. DevCrew's own branch checks are included below. Then call submit_verification. When you pass it, DevCrew opens the pull request for you.`,
};

function truncated(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated, ${text.length - max} more characters)` : text;
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stringList(value: unknown, maxItems: number, maxLength: number) {
  return Array.isArray(value) ? value.map((item) => text(item, maxLength)).filter(Boolean).slice(0, maxItems) : [];
}

// Runs one non-submit tool and returns its result as text for the model. Mistakes come back as text so the
// agent can correct itself; only a revoked GitHub token stops the run.
export async function executeTool(ctx: ToolContext, name: string, rawArgs: string): Promise<string> {
  const args = parseArgs(rawArgs);
  if (!args) return "Error: the arguments weren't valid JSON.";
  try {
    switch (name) {
      case "list_files":
        return await listFilesTool(ctx, args);
      case "read_file":
        return await readFileTool(ctx, args);
      case "get_diff":
        return await diffTool(ctx);
      case "write_file":
      case "delete_file":
        return await writeTool(ctx, name, args);
      default:
        return `Error: there is no tool named ${name}.`;
    }
  } catch (error) {
    if (error instanceof GithubAuthError) throw error;
    if (error instanceof GithubApiError) return `Error: GitHub answered ${error.status}${error.body ? ` (${error.body})` : ""}.`;
    if (error instanceof Error && !(error instanceof TypeError)) return `Error: ${error.message}`;
    throw error;
  }
}

async function listFilesTool(ctx: ToolContext, args: Record<string, unknown>) {
  const prefix = text(args.path_prefix, 300).replace(/^\.?\/+/, "").replace(/\/+$/, "");
  const contains = text(args.contains, 100).toLowerCase();
  const { files, truncated: treeTruncated } = await listTree(ctx.token, ctx.repoId, ctx.ref);
  const matches = files.filter(
    (file) => (!prefix || file.path === prefix || file.path.startsWith(`${prefix}/`)) && (!contains || file.path.toLowerCase().includes(contains)),
  );
  if (matches.length === 0) return "No files match.";
  const lines = matches.slice(0, MAX_LISTED_FILES).map((file) => `${file.path} (${file.size} B)`);
  const more = matches.length - lines.length;
  return [
    ...lines,
    more > 0 ? `… and ${more} more. Narrow it down with path_prefix or contains.` : "",
    treeTruncated ? "Note: GitHub truncated this repository's file list." : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function readFileTool(ctx: ToolContext, args: Record<string, unknown>) {
  const path = normalizeRepoPath(args.path);
  if (!path) return "Error: give a repository-relative path such as \"src/index.ts\".";
  const file = await readFile(ctx.token, ctx.repoId, ctx.ref, path);
  if (!file) return `Error: ${path} doesn't exist on ${ctx.ref}. Use list_files to find the right path.`;
  if (file.content.includes("\u0000")) return `${path} is a binary file (${file.size} B).`;

  const lines = file.content.split("\n");
  const start = Math.max(1, Number.isInteger(args.start_line) ? Number(args.start_line) : 1);
  const end = Math.min(lines.length, Number.isInteger(args.end_line) ? Number(args.end_line) : lines.length);
  const numbered = lines
    .slice(start - 1, end)
    .map((line, i) => `${start + i}\t${line}`)
    .join("\n");
  return truncated(`${path} (lines ${start}-${end} of ${lines.length})\n${numbered}`, MAX_READ_CHARS);
}

async function diffTool(ctx: ToolContext) {
  if (!ctx.branch) return "Error: there is no branch for this run yet.";
  const diff = await compareBranches(ctx.token, ctx.repoId, ctx.baseBranch, ctx.branch);
  if (diff.aheadBy === 0) return `${ctx.branch} has no commits ahead of ${ctx.baseBranch} yet.`;
  const commits = diff.commits.map((commit) => `- ${commit.sha.slice(0, 7)} ${commit.message.split("\n")[0]}`).join("\n");
  const files = diff.files
    .map((file) => `### ${file.filename} (${file.status}, +${file.additions} −${file.deletions})\n${file.patch ?? "(no textual diff)"}`)
    .join("\n\n");
  return truncated(`${diff.aheadBy} commits on ${ctx.branch}:\n${commits}\n\n${diff.files.length} files changed:\n\n${files}`, MAX_DIFF_CHARS);
}

async function writeTool(ctx: ToolContext, name: "write_file" | "delete_file", args: Record<string, unknown>) {
  if (!ctx.branch || ctx.branch === ctx.baseBranch) return "Error: you can only change files on the run's feature branch.";
  const path = normalizeRepoPath(args.path);
  if (!path) return "Error: give a repository-relative path such as \"src/index.ts\".";
  if (isProtectedPath(path)) return `Error: ${path} is protected. CI workflows and .env files need a person to change them.`;
  const message = text(args.commit_message, 200) || `Update ${path}`;

  if (name === "delete_file") {
    const { deleted } = await deleteFile(ctx.token, ctx.repoId, ctx.branch, path, message);
    return deleted ? `Deleted ${path}.` : `${path} doesn't exist, so nothing was deleted.`;
  }
  if (typeof args.content !== "string") return "Error: content must be the file's full text.";
  const { created } = await writeFile(ctx.token, ctx.repoId, ctx.branch, path, args.content, message);
  return `${created ? "Created" : "Updated"} ${path} (${args.content.split("\n").length} lines).`;
}

// Submit calls are validated here; a bad one goes back to the agent as an error instead of ending the stage.
export type AnalysisSubmission = { decision: "develop"; plan: AnalystPlan } | { decision: "needs_input"; summary: string; question: string };

export function parseAnalysis(raw: string): AnalysisSubmission | { error: string } {
  const args = parseArgs(raw);
  if (!args) return { error: "The arguments weren't valid JSON." };
  const summary = text(args.summary, 1000);
  if (!summary) return { error: "Add a summary." };
  if (args.decision === "needs_input") {
    const question = text(args.question, 1000);
    if (!question) return { error: "With needs_input, ask the one question a person must answer." };
    return { decision: "needs_input", summary, question };
  }
  if (args.decision !== "develop") return { error: "decision must be \"develop\" or \"needs_input\"." };
  const plan = text(args.plan, 12_000);
  const acceptanceCriteria = stringList(args.acceptance_criteria, 20, 500);
  if (!plan || acceptanceCriteria.length === 0) return { error: "A develop decision needs a plan and at least one acceptance criterion." };
  return { decision: "develop", plan: { summary, plan, acceptanceCriteria, files: stringList(args.files, 40, 300) } };
}

export function parseWork(raw: string): { summary: string } | { error: string } {
  const args = parseArgs(raw);
  const summary = args ? text(args.summary, 6000) : "";
  if (!summary) return { error: "Add a summary of your changes." };
  const notes = args ? text(args.notes_for_reviewer, 3000) : "";
  return { summary: notes ? `${summary}\n\n**Notes for the reviewer:** ${notes}` : summary };
}

export function parseReview(raw: string): ReviewResult | { error: string } {
  const args = parseArgs(raw);
  if (!args) return { error: "The arguments weren't valid JSON." };
  if (args.verdict !== "approve" && args.verdict !== "request_changes") return { error: "verdict must be approve or request_changes." };
  const summary = text(args.summary, 4000);
  if (!summary) return { error: "Add a summary." };
  const findings = (Array.isArray(args.findings) ? args.findings : [])
    .slice(0, 30)
    .flatMap((finding): ReviewResult["findings"] => {
      if (!finding || typeof finding !== "object") return [];
      const { severity, file, comment } = finding as Record<string, unknown>;
      const body = text(comment, 1500);
      if (!body) return [];
      return [{ severity: severity === "blocking" || severity === "nit" ? severity : "should_fix", file: text(file, 300) || undefined, comment: body }];
    });
  if (args.verdict === "request_changes" && findings.length === 0) return { error: "List at least one finding when you request changes." };
  return { verdict: args.verdict, summary, findings };
}

export function parseVerification(raw: string): { passed: boolean; report: string; problems: string[] } | { error: string } {
  const args = parseArgs(raw);
  if (!args || typeof args.passed !== "boolean") return { error: "passed must be true or false." };
  const report = text(args.report, 6000);
  if (!report) return { error: "Add a report." };
  const problems = stringList(args.problems, 20, 1000);
  if (!args.passed && problems.length === 0) return { error: "List what the Developer must fix." };
  return { passed: args.passed, report, problems };
}
