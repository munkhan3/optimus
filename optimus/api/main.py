"""Optimus API.

All data routes require an account session. The built frontend is served from /
so one Fly app serves both.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from .auth import require_user
from .db import get_engine
from .routers import (
    areas,
    assistant,
    auth,
    baselines,
    capacity,
    dashboard,
    goals,
    intake,
    planning,
    reviews,
    sessions,
    trackables,
    tree,
)
from .settings import get_metrics_config

app = FastAPI(
    title="Optimus",
    description=(
        "A personal operating system that compiles long-term intent into today's "
        "highest-value actions, and measures whether they produced progress."
    ),
    version="0.1.0",
)

app.include_router(auth.router)

for router in (
    trackables.router,
    sessions.router,
    goals.router,
    areas.router,
    baselines.router,
    capacity.router,
    planning.router,
    dashboard.router,
    assistant.router,
    reviews.router,
    intake.router,
    tree.router,
):
    app.include_router(router)


@app.get("/api/health", tags=["meta"])
def health() -> dict:
    """Liveness plus a real database round-trip -- not just process-is-up."""
    with get_engine().connect() as conn:
        conn.execute(text("SELECT 1"))
    return {"status": "ok", "database": "reachable"}


@app.get("/api/config", tags=["meta"], dependencies=[Depends(require_user)])
def config() -> dict:
    """The tunables the UI needs, so no constant is duplicated in the frontend."""
    c = get_metrics_config()
    return {
        "session_minutes": c.session.minutes,
        "min_sessions_for_iqr": c.pace.min_sessions_for_iqr,
        "stall_threshold_sessions": c.stall.threshold_sessions,
        "catch_up_cap": c.redistribution.catch_up_cap,
        "short_task_minutes": c.tiers.short_task_minutes,
    }


# --------------------------------------------------------------- static files

FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"

if FRONTEND_DIST.is_dir():
    app.mount(
        "/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets"
    )

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str) -> FileResponse:
        """Serve the SPA shell for any non-API path so client routing works.

        The /api guard is load-bearing, not defensive. Without it this route
        answers *unknown API paths* with index.html and a 200, so the client
        calls .json() on HTML and reports a parser error -- a message that says
        nothing about the actual problem, which is almost always that the
        running server predates the endpoint the page is asking for. A 404 with
        the path in it says that outright.
        """
        if full_path == "api" or full_path.startswith("api/"):
            raise HTTPException(
                404,
                f"No such API endpoint: /{full_path}. If the page expects it, "
                "the running server is older than the frontend it is serving.",
            )
        return FileResponse(FRONTEND_DIST / "index.html")
