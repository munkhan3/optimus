"""Ingestion and assistant endpoints.

Both surfaces are read-only with respect to the goal graph. Ingestion returns a
proposal the user must approve before anything is written (D10/D11); the
assistant has no write tools at all.
"""

from __future__ import annotations

import json
import logging
import queue
import threading
from collections.abc import Iterator
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session

from ..auth import get_user_session as get_session
from ..auth import require_user
from ..db import open_session
from ..llm import assistant as assistant_llm
from ..llm import ingest as ingest_llm
from ..llm.client import LLMUnavailable
from ..llm.tools import TOOL_DECLARATIONS
from ..models import User

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["assistant"])

# Well inside the 60s request timeout WebKit applies to a silent connection,
# and short enough that two consecutive misses still leave headroom.
HEARTBEAT_SECONDS = 15


class BrainDump(BaseModel):
    text: str


class Question(BaseModel):
    question: str
    history: list[dict] | None = None


@router.post("/ingest")
def ingest(body: BrainDump) -> dict:
    """§22. Returns a PROPOSAL. Nothing is persisted until the user approves it."""
    try:
        proposal = ingest_llm.parse_brain_dump(
            body.text, today=datetime.now(UTC).date().isoformat()
        )
    except LLMUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc

    return {
        "proposal": proposal.model_dump(),
        # §22.2: ranked by stakes x uncertainty, truncated at the threshold.
        # The full set is retained so nothing is lost, but only these get asked.
        "questions_to_ask": [g.model_dump() for g in ingest_llm.gaps_sorted(proposal)],
        "persisted": False,
        "note": (
            "This is a proposal, not saved state. Review and edit it, then create "
            "the goals you want. Estimated values carry a gap and will resurface."
        ),
    }


@router.post("/assistant")
def ask(body: Question, db: Session = Depends(get_session)) -> dict:
    """§26. Read-only tools over the metrics engine. No write tools exist in v0.

    Prefer /assistant/stream. This blocks for the whole tool loop, so a question
    needing several lookups can outlast the client's request timeout.
    """
    try:
        return assistant_llm.ask(db, body.question, body.history)
    except LLMUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    except RuntimeError as exc:
        # An exhausted model chain or an expired budget. /ingest has always
        # reported this as a 502; without this the assistant raised a bare 500
        # whose body said only "Internal Server Error".
        raise HTTPException(502, str(exc)) from exc


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event)}\n\n"


@router.post("/assistant/stream")
def ask_streaming(body: Question, user: User = Depends(require_user)) -> StreamingResponse:
    """§26, delivered incrementally.

    The loop runs on a worker thread and reports through a queue so this
    generator can emit a keepalive whenever the model has been thinking for a
    while. Without that, one slow turn is indistinguishable from a dead
    connection and the browser drops it.
    """
    # Read eagerly: `user` belongs to the dependency's session, which closes
    # when this function returns -- long before the body is produced.
    user_id = user.id
    question, history = body.question, body.history

    def produce() -> Iterator[str]:
        events: queue.Queue = queue.Queue()

        def work() -> None:
            # Its own session, for the same reason: the request-scoped one is
            # already gone by the time this thread starts reading.
            try:
                with open_session(user_id) as db:
                    for event in assistant_llm.ask_stream(db, question, history):
                        events.put(event)
            except LLMUnavailable as exc:
                events.put({"type": "error", "message": str(exc)})
            except Exception as exc:
                log.exception("assistant stream failed")
                events.put({"type": "error", "message": str(exc)})
            finally:
                events.put(None)

        threading.Thread(target=work, daemon=True).start()

        while True:
            try:
                event = events.get(timeout=HEARTBEAT_SECONDS)
            except queue.Empty:
                # A comment frame: no data, but bytes on the wire, which is the
                # whole point. It resets the client's idle timer while a slow
                # model turn is still running.
                yield ": keepalive\n\n"
                continue
            if event is None:
                return
            yield _sse(event)

    return StreamingResponse(
        produce(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/assistant/tools")
def list_tools() -> dict:
    """What the assistant can see. Useful for confirming it cannot write."""
    return {
        "tools": [
            {"name": t.name, "description": t.description} for t in TOOL_DECLARATIONS
        ],
        "write_tools": [],
        "note": "v0 has no write tools by design (D10). The model never owns state.",
    }
