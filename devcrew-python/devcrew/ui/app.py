"""FastAPI + WebSocket control room for the DevCrew Python pipeline.

Endpoints:
  GET  /                  the control room UI (static)
  GET  /api/state         full snapshot: team, tasks, runs, PRs, ledger tail
  POST /api/reset         recreate the demo workspace (clears board and ledger)
  POST /api/tasks         create a task        {title, description?, type?, priority?}
  POST /api/run           start a run          {task_id, mode: offline|live}
  WS   /ws                live pipeline events + state refreshes

The pipeline already emits stage events through its `event_sink`; this server
forwards them to every WebSocket client (thread-safely) while the run executes
in a background thread.

Run:
  uvicorn devcrew.ui.app:app --reload --port 8000
"""

from __future__ import annotations

import asyncio
import threading
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from ..budget import monthly_spend, run_check_for
from ..config import AGENT_ROLES, STAGE_AGENT, TASK_RUN_STAGE_LABELS
from ..demo import offline_model
from ..factory import add_task, create_workspace
from ..llm import build_llm, openrouter_configured
from ..pipeline import start_task_run
from ..state import task_key

load_dotenv()

STATIC_DIR = Path(__file__).parent / "static"
LEDGER_TAIL = 80


class Broker:
    """Fan-out of pipeline events to WebSocket clients, thread-safe from the
    run worker thread."""

    def __init__(self) -> None:
        self._clients: set[asyncio.Queue] = set()
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=500)
        self._clients.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._clients.discard(queue)

    def publish(self, event: dict) -> None:
        """Called from any thread (the run worker calls this as event_sink)."""
        for queue in list(self._clients):
            if self._loop and self._loop.is_running():
                self._loop.call_soon_threadsafe(self._put, queue, event)
            else:
                self._put(queue, event)

    @staticmethod
    def _put(queue: asyncio.Queue, event: dict) -> None:
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            pass


class UISession:
    """One demo workspace. Only one run at a time, like the original app."""

    def __init__(self, workdir: Path, merge_mode: str = "auto") -> None:
        self.workdir = Path(workdir)
        self.merge_mode = merge_mode
        self.lock = threading.Lock()
        self.running = False
        self.last_error: Optional[str] = None
        self._create()

    def _create(self) -> None:
        self.store, self.repo = create_workspace(self.workdir / "workspace",
                                                 name="Dev Crew",
                                                 merge_mode=self.merge_mode)

    def reset(self) -> None:
        with self.lock:
            self._create()
            self.last_error = None

    # -- serialisation --------------------------------------------------------
    def snapshot(self) -> dict:
        store = self.store
        running_run = next((r for r in store.runs.values() if r.status == "running"), None)
        agents = []
        for role in AGENT_ROLES:
            agent = store.agent_by_role(role)
            spent = monthly_spend(store, agent.id)
            check = run_check_for(agent, spent)
            status = "working" if (running_run and STAGE_AGENT.get(running_run.stage) == role) else (
                "paused" if not agent.enabled else ("over_budget" if not check.ok else "idle"))
            agents.append({
                "role": role, "name": agent.name, "status": status,
                "budget_cents": agent.budget_cents, "spent_cents": spent,
                "max_turns": agent.max_turns, "trust_score": agent.trust_score,
            })
        tasks = [{
            "id": t.id, "key": task_key(store.name, t), "title": t.title,
            "type": t.type, "priority": t.priority, "status": t.status,
            "assignee": t.assignee, "run_status": t.agent_run_status,
        } for t in sorted(store.tasks.values(), key=lambda t: t.number)]
        runs = [{
            "id": r.id, "task_id": r.task_id, "stage": r.stage,
            "stage_label": TASK_RUN_STAGE_LABELS.get(r.stage, r.stage),
            "status": r.status, "round": r.round, "branch": r.branch, "error": r.error,
        } for r in store.runs.values()]
        prs = [{
            "number": p.number, "title": p.title, "state": p.state,
            "head_branch": p.head_branch, "changed_files": p.changed_files,
            "additions": p.additions, "deletions": p.deletions,
        } for p in store.pull_requests.values()]
        ledger = [{
            "at": e.created_at.isoformat(), "kind": e.kind, "title": e.title,
            "detail": e.detail, "cost_cents": e.cost_cents,
            "agent": store.agents[e.agent_id].name if e.agent_id in store.agents else None,
        } for e in store.activities[-LEDGER_TAIL:]]
        return {
            "merge_mode": store.merge_mode, "running": self.running,
            "live_available": openrouter_configured(), "last_error": self.last_error,
            "agents": agents, "tasks": tasks, "runs": runs, "pull_requests": prs,
            "ledger": ledger,
        }


broker = Broker()
session = UISession(Path(__file__).resolve().parent.parent.parent / ".ui-workspace")

app = FastAPI(title="DevCrew Python - Control Room")
app.state.broker = broker


@app.on_event("startup")
def _attach_loop() -> None:
    broker.attach_loop(asyncio.get_event_loop())


# --- REST ------------------------------------------------------------------------

class TaskIn(BaseModel):
    title: str
    description: str = ""
    type: str = "feature"
    priority: str = "medium"


class RunIn(BaseModel):
    task_id: str
    mode: str = "offline"  # offline | live


@app.get("/api/state")
def get_state() -> dict:
    with session.lock:
        return session.snapshot()


@app.post("/api/reset")
def reset() -> dict:
    session.reset()
    broker.publish({"type": "state"})
    return {"ok": True}


@app.post("/api/tasks")
def create_task(body: TaskIn) -> dict:
    with session.lock:
        task = add_task(session.store, body.title, body.description or "",
                        type=body.type, priority=body.priority)
        broker.publish({"type": "state"})
        return {"id": task.id, "key": task_key(session.store.name, task)}


@app.post("/api/run")
def run_task(body: RunIn) -> JSONResponse:
    if session.running:
        return JSONResponse({"error": "The AI team is already working on a task."}, status_code=409)
    with session.lock:
        task = session.store.tasks.get(body.task_id)
        if task is None:
            return JSONResponse({"error": "Unknown task."}, status_code=404)
        if body.mode == "live":
            if not openrouter_configured():
                return JSONResponse({"error": "OPENROUTER_API_KEY is not set on the server."},
                                    status_code=400)
            model = build_llm()
            model_name = model.model
        else:
            model = offline_model()
            model_name = "scripted-chat-model (offline)"

        def worker() -> None:
            session.running = True
            session.last_error = None
            broker.publish({"type": "run_started", "task_key": task_key(session.store.name, task)})
            try:
                error = start_task_run(session.store, session.repo, task, model, model_name,
                                       event_sink=broker.publish)
                session.last_error = error
            finally:
                session.running = False
                broker.publish({"type": "state"})

        threading.Thread(target=worker, daemon=True, name="devcrew-run").start()
        return {"ok": True}


# --- WebSocket ---------------------------------------------------------------------

@app.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    await websocket.accept()
    queue = broker.subscribe()
    try:
        await websocket.send_json({"type": "state", "snapshot": session.snapshot()})
        while True:
            # Wait for the next event while still noticing client disconnects.
            receive_task = asyncio.ensure_future(websocket.receive_text())
            send_task = asyncio.ensure_future(queue.get())
            done, pending = await asyncio.wait({receive_task, send_task},
                                               return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            if send_task in done:
                event = send_task.result()
                if event.get("type") == "state":
                    await websocket.send_json({"type": "state", "snapshot": session.snapshot()})
                else:
                    await websocket.send_json(event)
            if receive_task in done:
                # A client message: only pings/close expected; ignore content.
                continue
    except WebSocketDisconnect:
        pass
    finally:
        broker.unsubscribe(queue)


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="ui")
