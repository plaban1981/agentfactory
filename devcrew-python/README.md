# DevCrew Python

A faithful Python port of the **DevCrew** AI software team from the YouTube
course *"Build an AI Agent Company Using Claude Code & Next.js"* (source:
`devcrew-yt-project`, Next.js + TypeScript + OpenAI Responses API).

This port keeps the original product logic stage for stage, but runs the team
on **LangChain Deep Agents** (`deepagents` 0.7.32) with **OpenRouter** as the
LLM provider (`anthropic/claude-sonnet-5.5` by default).

```
Todo task -> Analyst -> Developer -> Reviewer -> Tester -> Pull request -> Merge
```

## What was ported (same logic)

| Original (TypeScript)              | Python                          |
| ---------------------------------- | ------------------------------- |
| `lib/workflow.ts`                  | `devcrew/config.py`             |
| `lib/agent-defaults.ts`            | `devcrew/team.py` (verbatim instructions) |
| `lib/ai-team.ts`                   | `devcrew/config.py` vocabulary  |
| `lib/agent-budget.ts`              | `devcrew/budget.py`             |
| `lib/agents.ts` `runTrustChecks`   | `devcrew/trust.py`              |
| `lib/agent-tools.ts`               | `devcrew/tools.py`              |
| `lib/github-repo.ts`               | `devcrew/repo.py` (local git)   |
| `lib/task-runs.ts`                 | `devcrew/pipeline.py`           |
| `lib/openai.ts` turn loop          | Deep Agents + middleware in `devcrew/agents.py` |
| OpenAI Responses API               | `anthropic/claude-sonnet-5.5` via OpenRouter (`devcrew/llm.py`) |
| Postgres (Drizzle)                 | in-memory `Store` + JSONL ledger (`devcrew/state.py`) |
| Cloudhike background jobs          | inline step loop (the original's own dev fallback) |

### How the original's agent loop maps to Deep Agents

| Original mechanism (task-runs.ts)                  | Deep Agents equivalent                                     |
| -------------------------------------------------- | ---------------------------------------------------------- |
| `turns >= maxTurns` circuit breaker                | `ModelCallLimitMiddleware(run_limit=max_turns, exit_behavior="end")` |
| `assertAgentCanRun()` before every model/tool call | `BudgetMiddleware.before_model` / `wrap_tool_call`         |
| `pendingCost += response.costCents` per turn       | `CostTracker` model wrapper (a `BaseChatModel`)            |
| hand-rolled todo planning                          | `TodoListMiddleware` (`write_todos`)                       |
| `submit_*` tool ends the stage                     | submit tool validates into a `SubmissionBox`; the loop ends when the model wraps up after "Submitted." |
| per-stage agent with stage tools + brief           | one `create_deep_agent()` per stage with `STAGE_TOOLS`/`STAGE_BRIEFS` |

## Setup

```bash
# from devcrew-python/
pip install -r requirements.txt     # use your Python 3.12
```

Optional for live mode: copy `.env.example` to `.env` and set `OPENROUTER_API_KEY`.

## Run it, step by step

```bash
# 1. Offline demo: deterministic scripted model, no network, no key.
python -m devcrew.cli demo --mode offline

# 2. Live demo: real Deep Agents on OpenRouter (claude-sonnet-5.5).
python -m devcrew.cli demo --mode live --task "Add a delete_task function"

# 3. Watch a merge-conflict follow-up task (manual merge mode).
python -m devcrew.cli demo --mode offline --merge-mode manual

# 4. The team's built-in trust scan (six weighted checks from the original app).
python -m devcrew.cli trust

# 5. Offline test suite (32 tests, no network).
python -m tests.test_devcrew

# 6. Web control room (FastAPI + WebSocket, light theme).
uvicorn devcrew.ui.app:app --port 8017
#    then open http://127.0.0.1:8017  (port 8000 is often taken on this machine;
#    any free port works). Windows: `cmd //c run-ui.bat` starts it detached.
```

The demo prints each stage as it happens (Analyzing -> Developing -> Reviewing ->
Verifying -> PR -> Merge), then a control-room summary and the full agent
activity ledger with per-stage spend.

## Web control room

`devcrew/ui/app.py` serves a single-page control room (vanilla JS, no build
step) plus a small JSON/WebSocket API. It reuses the same demo workspace,
pipeline and scripted offline model as the CLI:

- `GET /api/state` — team (trust score, monthly budget bar, status), tasks,
  runs, PRs, ledger tail.
- `POST /api/tasks` — create a task `{title, description?, type?, priority?}`.
- `POST /api/run` — start a run `{task_id, mode: offline|live}`; runs in a
  background thread, one at a time (409 while busy).
- `POST /api/reset` — recreate the demo workspace.
- `WS /ws` — a full snapshot on connect, then live pipeline events
  (`run_started`, `stage`, `agent_start/end`, `pr_opened`, `run_finished`).

The page shows the AI team cards, the six pipeline stage chips, a board, open
PRs, a live event feed, and the activity ledger. `examples/../ws_smoke.py`
(at the project root: `ws_smoke.py`) drives the whole thing headlessly:
reset → create task → run offline → collect WS events → assert the PR merged
and the task landed in done.

## Repository backend

The original talks to the GitHub API. This port uses a **local git checkout**
with the same rules: writes only on the run's feature branch, one commit per
`write_file`/`delete_file`, protected paths (`.env`, `.github/workflows`)
refused, `feat/<key>-<slug>` branch naming with run-id suffix on collision,
merge conflicts abort cleanly and file a follow-up task in Todo.

## Notes and limits

- Cloudhike job dispatch and heartbeats/retries are infrastructure, not agent
  logic; the port runs steps inline (the original's own development fallback)
  and logs everything to a JSONL ledger. The original's Next.js office/board
  views are replaced by the FastAPI + WebSocket control room above.
- Token prices in `devcrew/llm.py` are configurable estimates used only for the
  budget ledger.
- The Switch Trust red-teaming integration from the original is not ported;
  the built-in `runTrustChecks` scan is (`devcrew trust`).
