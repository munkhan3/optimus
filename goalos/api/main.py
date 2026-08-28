"""Goal OS API.

Every route below /api requires the single-user bearer token (§19). The built
frontend is served from / so one Fly app serves both.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from .auth import require_token
from .db import get_engine
from .routers import baselines, capacity, goals, planning, sessions, trackables
from .settings import get_metrics_config

app = FastAPI(
    title="Goal OS",
    description=(
        "A personal operating system that compiles long-term intent into today's "
        "highest-value actions, and measures whether they produced progress."
    ),
    version="0.1.0",
)

for router in (
    trackables.router,
    sessions.router,
    goals.router,
    baselines.router,
    capacity.router,
    planning.router,
):
    app.include_router(router, dependencies=[Depends(require_token)])


@app.get("/api/health", tags=["meta"])
def health() -> dict:
    """Liveness plus a real database round-trip -- not just process-is-up."""
    with get_engine().connect() as conn:
        conn.execute(text("SELECT 1"))
    return {"status": "ok", "database": "reachable"}


@app.get("/api/config", tags=["meta"], dependencies=[Depends(require_token)])
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
        """Serve the SPA shell for any non-API path so client routing works."""
        return FileResponse(FRONTEND_DIST / "index.html")
