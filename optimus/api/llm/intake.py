"""The intake interview (§22, §15).

`ingest.parse_brain_dump` is one-shot: dump in, proposal out. That is the first
turn of a conversation, not the whole of it -- §15.4 makes the relationship
continue through questions, and §22.2 says to ask in priority order and stop
when marginal priority drops below threshold.

This module carries a proposal across turns and lets the model patch it.

The single most important property here is STABILITY. The current proposal is
passed into the prompt and the model is told to modify it rather than rebuild
it, and every node carries a key it must preserve. Without that the tree is
re-derived from scratch each turn and the UI, which diffs on key, sees every
node as new -- so "watch your goals assemble" degrades into a strobe. The
constraint is as much a product requirement as a token-cost one.
"""

from __future__ import annotations

import json

from google.genai import types
from pydantic import BaseModel, Field

from .client import get_client, max_tokens, model, to_contents
from .ingest import SYSTEM as INGEST_RULES
from .ingest import IngestProposal


class InterviewTurn(BaseModel):
    """One exchange: what to say, and the tree as it now stands."""

    reply: str = Field(
        description=(
            "What to say to the user. Normally ONE question -- the highest-priority "
            "open gap. Never a list of questions. Acknowledge briefly what you just "
            "learned, then ask."
        )
    )
    proposal: IngestProposal = Field(
        description=(
            "The COMPLETE proposal as it now stands, not a delta. Carry forward "
            "every node the user has not corrected, with its key unchanged."
        )
    )
    interview_complete: bool = Field(
        description=(
            "True when the remaining gaps are not worth asking about -- their "
            "stakes x uncertainty has dropped below the point where being wrong is "
            "expensive. Do not hold out for completeness."
        )
    )
    answered_gap_key: str | None = Field(
        default=None,
        description="The gap key this user message resolved, if it resolved one.",
    )


INTERVIEW_RULES = f"""{INGEST_RULES}

You are now conducting this as a CONVERSATION rather than a single pass.

Each turn you receive the proposal so far and the user's latest message. Return
the complete updated proposal plus one reply.

Conversation rules:

- ASK ONE QUESTION AT A TIME. A list of questions is a form, and the user
  already has forms. Acknowledge what you just learned in a clause, then ask the
  single highest-priority open gap.

- PRESERVE KEYS. Every node you carry forward keeps the exact key it already
  has. Mint a new key only for a node that genuinely did not exist before. The
  interface animates newly-keyed nodes, so a changed key on an unchanged node
  reads to the user as work being redone.

- BUILD INCREMENTALLY. It is correct for the tree to be sparse early. Add
  structure as the user gives it to you rather than inventing scaffolding to
  look productive. An empty milestone list is a truthful state.

- STOP EARLY. §15.3: ask where being wrong is expensive. "Read the Green Book by
  Dec 1" needs nothing from you. What "demo-ready" means costs a month if you
  guess. When what is left is cheap to be wrong about, set interview_complete
  and say what you have.

- The user is talking, possibly transcribed from speech. Expect fragments, self-
  correction, and thinking aloud. Do not ask them to repeat themselves over
  small ambiguities you can carry as a gap instead."""


def first_turn(text: str, today: str) -> InterviewTurn:
    """Open the interview with a brain dump (§22.1)."""
    return _turn(
        today=today,
        messages=[
            {
                "role": "user",
                "content": (
                    "Here is everything on my mind. Pull out what you can, then ask "
                    f"me your single most important question.\n\n---\n{text}\n---"
                ),
            }
        ],
        current=None,
    )


def next_turn(
    history: list[dict],
    current: IngestProposal,
    user_message: str,
    today: str,
) -> InterviewTurn:
    """Continue the interview with the user's answer."""
    return _turn(
        today=today,
        messages=[*history, {"role": "user", "content": user_message}],
        current=current,
    )


def _turn(today: str, messages: list[dict], current: IngestProposal | None) -> InterviewTurn:
    client = get_client()

    system = f"Today is {today}.\n\n{INTERVIEW_RULES}"
    if current is not None:
        # The proposal goes in the system instruction rather than the transcript:
        # it is state, not something the user said, and keeping it out of the
        # message history stops it being re-read as conversation.
        system += (
            "\n\nThe proposal so far, which you must carry forward and modify "
            "rather than rebuild:\n\n"
            f"{json.dumps(current.model_dump(), indent=2)}"
        )

    response = client.models.generate_content(
        model=model(),
        contents=to_contents(messages),
        config=types.GenerateContentConfig(
            system_instruction=system,
            max_output_tokens=max_tokens(),
            response_mime_type="application/json",
            response_schema=InterviewTurn,
        ),
    )
    if response.parsed is None:
        raise RuntimeError("the model returned no parsed turn")
    return response.parsed
