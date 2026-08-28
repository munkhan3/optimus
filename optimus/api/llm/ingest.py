"""Brain-dump ingestion and the gap-filling interview (§22).

The mental model is a competent personal assistant on their first week (§15),
not a form and not a chatbot. They take everything you dump on them, work out
what they cannot responsibly infer, and ask about the things where being wrong
is expensive.

Three rules do the real work, and all three are about refusing to guess:

  Ask for verifiable CONDITIONS, not numbers, when no natural counter exists
  (§22.3). For an MVP the question is "what must someone be able to do in it?"
  -- never "what MRR?". Forcing a number where none exists is the single most
  damaging thing the system can do (§10), because every projection downstream
  then rests on a figure nobody believes.

  Never fabricate a value to move on. Leave the gap open and flag it.

  Questions are budgeted by consequence (§15.3). Rank by stakes x uncertainty
  and stop when marginal priority drops below threshold -- a good assistant does
  not interrogate you about everything equally.

The output is a PROPOSAL, not persisted state (D10/D11). The user edits and
approves it; nothing here writes to the database.
"""

from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel, Field

from ..settings import get_raw_config
from .client import get_client, max_tokens, model

Provenance = Literal["grounded", "user_supplied", "model_estimated"]


class ProposedTrackable(BaseModel):
    title: str
    unit: str = Field(description="The natural counter, e.g. 'pages'. Omit if none exists.")
    total_units: float
    total_units_source: Provenance = Field(
        description=(
            "'grounded' only if the number came from a verifiable fact such as a "
            "stated page count. 'user_supplied' if the user said it. "
            "'model_estimated' if you inferred it -- which REQUIRES a gap."
        )
    )
    task_type: Literal["reading", "problems", "writing", "exploratory", "admin"]
    prior_pace: float | None = Field(
        default=None, description="The user's own stated units-per-session estimate, if given."
    )


class ProposedMilestone(BaseModel):
    title: str
    definition_of_done: str = Field(
        description=(
            "What must be TRUE for this to be done. Verifiable, not necessarily "
            "numeric. A checkable condition is a good answer."
        )
    )
    dod_source: Literal["user_supplied", "model_estimated"]
    deadline: str | None = Field(default=None, description="ISO date, or null.")
    exploratory: bool = Field(
        default=False,
        description=(
            "True when the work has no honest counter. Mark it exploratory rather "
            "than inventing units for it."
        ),
    )
    planned_sessions: int | None = Field(
        default=None,
        description="For exploratory work: a session budget instead of fabricated units.",
    )
    trackables: list[ProposedTrackable] = Field(default_factory=list)


class ProposedGoal(BaseModel):
    title: str
    kind: Literal["vision", "goal"] = "goal"
    definition_of_done: str
    dod_source: Literal["user_supplied", "model_estimated"]
    deadline: str | None = Field(
        default=None,
        description=(
            "ISO date. Null means this should be PARKED -- a goal with no deadline "
            "is an intention, not work in progress. Visions never have one."
        ),
    )
    activation: Literal["active", "parked"] = "parked"
    pace_mode: Literal["carry_forward", "reset_period"] = "carry_forward"
    reset_period_days: int | None = Field(
        default=None,
        description="Set for recurring commitments, e.g. 7 for 'gym six days a week'.",
    )
    stakes: int = Field(ge=1, le=5)
    milestones: list[ProposedMilestone] = Field(default_factory=list)


class ProposedGap(BaseModel):
    question: str = Field(
        description=(
            "Ask for a verifiable condition when no natural counter exists. "
            "Never ask for a number the user has no basis to give."
        )
    )
    priority: float = Field(description="stakes x uncertainty, both 1-5.")
    subject: str = Field(description="Which proposed goal/milestone/trackable this concerns.")
    why_it_matters: str = Field(
        description="What goes wrong downstream if this stays unanswered."
    )


class IngestProposal(BaseModel):
    """The full output. Not persisted until the user approves it."""

    goals: list[ProposedGoal] = Field(default_factory=list)
    gaps: list[ProposedGap] = Field(default_factory=list)
    notes: str = Field(default="", description="Anything you could not place.")


SYSTEM = """\
You are the intake assistant for Optimus, a personal planning system for a single user.

Your job is to turn an unstructured brain dump into a structured PROPOSAL. You do
not write to any database; the user reviews and edits everything you produce.

The rules below are not style preferences. Violating them corrupts every number
the system computes downstream.

1. NEVER invent a quantity to fill a field. If the user says "build a startup",
   do not extract "$10k MRR" because a field wants a number. Ask what must be
   true for it to be done.

2. A definition of done must be VERIFIABLE, not necessarily NUMERIC. Both of
   these are good:
     - "Green Book finished"  (naturally metered)
     - "A stranger can sign up, build a goal tree, and log a session unaided"
   Where a natural counter exists, use it. Where it does not, write a checkable
   condition and mark the milestone exploratory with a session budget.

3. Provenance is mandatory and honest. Mark total_units 'grounded' ONLY when the
   number is a verifiable fact (a real page count). If you inferred it, mark it
   'model_estimated' AND raise a gap for it. Never mark a guess as grounded.

4. A goal with no deadline is an intention, not work in progress: leave it
   parked. Visions are directional and unbounded -- they never carry a deadline
   and are never 'active' work competing for time.

5. Recurring commitments ("gym six days a week") are reset_period with
   reset_period_days set, not carry_forward. Missing two gym sessions must not
   create a debt of eight.

6. Budget your questions by consequence: rank gaps by stakes x uncertainty. Ask
   hard where being wrong costs months (what "demo-ready" means). Ask nothing
   where the spec is already clear ("read Green Book by Dec 1" is complete).
   Being wrong about reading pace costs a week and self-corrects.

Raise a gap for every value you estimated. It is always better to leave a gap
open than to fill it with something plausible."""


def parse_brain_dump(text: str, today: str) -> IngestProposal:
    """§22.1-22.2. Returns a proposal; persists nothing.

    Uses structured outputs so the response is schema-valid by construction --
    §26 asks for defensive parsing with a re-prompt, which was the right advice
    before the API could guarantee the shape.
    """
    client = get_client()
    config = get_raw_config().get("llm", {})
    retries = int(config.get("ingest_max_retries", 2))

    last_error: Exception | None = None
    for _attempt in range(retries + 1):
        try:
            response = client.messages.parse(
                model=model(),
                max_tokens=max_tokens(),
                system=SYSTEM,
                thinking={"type": "adaptive"},
                messages=[
                    {
                        "role": "user",
                        "content": (
                            f"Today is {today}.\n\n"
                            "Here is my brain dump. Extract goals, milestones, "
                            "trackables, and the questions you need answered.\n\n"
                            f"---\n{text}\n---"
                        ),
                    }
                ],
                output_config={"format": IngestProposal},
            )
            if response.parsed_output is None:
                raise ValueError("model returned no parsed output")
            return response.parsed_output
        except Exception as exc:  # noqa: BLE001 -- retried, then re-raised
            last_error = exc

    raise RuntimeError(f"ingestion failed after {retries + 1} attempts: {last_error}")


def gaps_sorted(proposal: IngestProposal) -> list[ProposedGap]:
    """§22.2: ask in priority order, and stop below the threshold.

    Do not walk the full list. A good assistant does not interrogate you about
    everything equally.
    """
    interview = get_raw_config().get("interview", {})
    floor = float(interview.get("min_priority_to_ask", 1.5))
    limit = int(interview.get("max_questions_per_session", 7))
    ranked = sorted(proposal.gaps, key=lambda g: -g.priority)
    return [g for g in ranked if g.priority >= floor][:limit]


def proposal_to_json(proposal: IngestProposal) -> str:
    return json.dumps(proposal.model_dump(), indent=2)
