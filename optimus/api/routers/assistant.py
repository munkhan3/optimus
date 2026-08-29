"""Ingestion and assistant endpoints.

Both surfaces are read-only with respect to the goal graph. Ingestion returns a
proposal the user must approve before anything is written (D10/D11); the
assistant has no write tools at all.
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session

from ..auth import get_user_session as get_session
from ..llm import assistant as assistant_llm
from ..llm import ingest as ingest_llm
from ..llm.client import LLMUnavailable
from ..llm.tools import TOOL_DECLARATIONS

router = APIRouter(prefix="/api", tags=["assistant"])


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
    """§26. Read-only tools over the metrics engine. No write tools exist in v0."""
    try:
        return assistant_llm.ask(db, body.question, body.history)
    except LLMUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc


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
