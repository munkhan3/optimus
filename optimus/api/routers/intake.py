"""The intake interview endpoints (§22).

Conversation state is client-side: history and the proposal are posted each
turn, the same stateless shape /api/assistant already uses. There is no
interview table because an abandoned interview should leave no trace, and a
resumed one is just the client posting what it still holds.
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session

from ..auth import get_user_session as get_session
from ..llm import intake as intake_llm
from ..llm.client import LLMUnavailable
from ..llm.ingest import IngestProposal, gaps_sorted
from ..repo.intake_service import persist_proposal
from ..settings import get_settings

router = APIRouter(prefix="/api/intake", tags=["intake"])


class TurnRequest(BaseModel):
    message: str
    history: list[dict] = []
    proposal: IngestProposal | None = None


class ApproveRequest(BaseModel):
    proposal: IngestProposal


def _today() -> str:
    return datetime.now(UTC).date().isoformat()


@router.get("/status")
def status() -> dict:
    """Whether the interview can run at all.

    The UI asks this before showing a conversation it cannot hold, so a missing
    key surfaces as an explanation and a link to the manual forms rather than a
    503 in the middle of a sentence.
    """
    return {"available": bool(get_settings().gemini_api_key)}


@router.post("/turn")
def turn(body: TurnRequest) -> dict:
    """One exchange. Returns the reply and the whole tree as it now stands."""
    try:
        if body.proposal is None:
            result = intake_llm.first_turn(body.message, today=_today())
        else:
            result = intake_llm.next_turn(
                history=body.history,
                current=body.proposal,
                user_message=body.message,
                today=_today(),
            )
    except LLMUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc

    return {
        "reply": result.reply,
        "proposal": result.proposal.model_dump(),
        "interview_complete": result.interview_complete,
        "answered_gap_key": result.answered_gap_key,
        # §22.2: ranked by stakes x uncertainty and truncated at the threshold.
        # The full set is retained on the proposal; these are the ones worth asking.
        "remaining_questions": [g.model_dump() for g in gaps_sorted(result.proposal)],
        "history": [
            *body.history,
            {"role": "user", "content": body.message},
            {"role": "assistant", "content": result.reply},
        ],
        "persisted": False,
    }


@router.post("/approve", status_code=201)
def approve(body: ApproveRequest, db: Session = Depends(get_session)) -> dict:
    """Write the approved tree. All of it, or none of it (D11)."""
    if not body.proposal.goals:
        raise HTTPException(422, "nothing to create: the proposal has no goals")
    return persist_proposal(db, body.proposal)
