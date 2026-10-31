# POC.md — DevCrew Python port (LangChain Deep Agents + OpenRouter)

Date: 2026-10-31
Scope: logic-faithful Python port of `devcrew-yt-project` (Next.js/TS, OpenAI
Responses API) onto `deepagents` 0.7.32 + `langchain` 1.4.7 with OpenRouter
(`anthropic/claude-sonnet-5.5`) as the LLM.

## Acceptance criteria

1. Same pipeline stages and hand-offs as the original: analysis -> development
   -> review -> testing -> pull_request -> merge, with STAGE_AGENT mapping and
   rework rounds (MAX_REWORK_ROUNDS = 2). ✅
2. Same agent defaults: four roles, verbatim instructions + shared guardrails,
   skills, monthly budgets, max turns (analyst 20 / developer 60 / reviewer 20 /
   tester 15). ✅
3. Same budget rules: `assertAgentCanRun` before every model/tool call, min
   balance 25c to start, 80% warning, budget_reached event, monthly reset. ✅
4. Same repo safety: no writes on the default branch, protected paths
   (`.env`, `.github/workflows`) refused, `feat|fix/<key>-<slug>` branches,
   branch checks (exists / separate / has commits / files changed / planned
   files touched / no protected files) overrule a Tester pass. ✅
5. Same submit-contract validation (submit_analysis / submit_work /
   submit_review / submit_verification) with errors returned to the agent. ✅
6. Same built-in trust scan (six weighted checks). ✅
7. Offline test suite 100% green; live mode one command away. ✅

## Verification

- `python -m tests.test_devcrew` — **32/32 green** (budget x8, trust x2,
  parsers x6, repo x6 incl. idempotent sample-repo seeding, pipeline e2e:
  happy path manual + auto merge, rework round, rework exhaustion,
  needs_input, max-turns, budget gate, branch checks, merge-conflict
  follow-up, branch naming).
- `python -m devcrew.cli demo --mode offline` — full pipeline run with the
  step-by-step event log and activity ledger (see README).
- `python ws_smoke.py` (server running) — end-to-end UI API check: WebSocket
  snapshot on connect, reset, create task, run offline, 22+ live pipeline
  events streamed, final state asserts PR merged and task in done. **PASS.**
- Live mode was not executed here (no OPENROUTER_API_KEY in this environment);
  run `python -m devcrew.cli demo --mode live` after adding a key to `.env`.

## Runbook

```bash
pip install -r requirements.txt          # Python 3.12
python -m tests.test_devcrew             # offline gate, must print 32/32
cp .env.example .env                     # then set OPENROUTER_API_KEY
python -m devcrew.cli demo --mode live   # real claude-sonnet-5.5 run
python examples/run_task.py "Your task"  # minimal live example
uvicorn devcrew.ui.app:app --port 8017   # web control room (or run-ui.bat)
python ws_smoke.py                       # headless WS/API smoke, needs server up
```

## Hardening checklist (before production use)

- [ ] Swap `LocalRepo` for a real GitHub backend (token auth, per-run branch
      protection, PR API) — the tool contract stays identical.
- [ ] Persist `Store` to a database (the TS app uses Postgres) for resume and
      audit; add the Cloudhike-style job dispatch the original uses.
- [x] Stream `event_sink` events to a UI (the original's office/board views) —
      done as a FastAPI + WebSocket control room (`devcrew/ui/`), light theme,
      live event feed + board + ledger; verified headlessly by `ws_smoke.py`.
- [ ] Wire real token prices from OpenRouter's `/api/v1/models` into the
      budget ledger instead of the configurable estimates.
- [ ] Add the Switch Trust red-team scan integration (out of scope here).
- [ ] Concurrency: the original claims runs with pg advisory locks; add a
      per-workspace run lock when moving beyond inline execution.

## Industry benefits (why this shape matters)

- **Banking/fintech:** every stage transition and dollar of agent spend lands
  in an append-only ledger — SOX/DORA-style audit trails for autonomous
  change. Protected paths + human-merge mode keep CI/auth/billing changes
  behind a person.
- **Insurance:** the Tester's verification gate plus DevCrew's branch checks
  are a deterministic second opinion over model judgment before anything
  reaches a merge — the same dual-control pattern used for claim automation.
- **Retail/e-commerce:** low-risk tasks (copy, config, small features) can run
  auto-merge within a hard monthly budget per agent; runaway loops stop at
  the 80% warning and the min-balance floor.
- **OSS maintainers:** the Analyst's needs_input verdict and the rework loop
  map directly to triage bots that ask instead of guessing, and that give up
  loudly after bounded rounds instead of burning tokens.
