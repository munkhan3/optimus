"""Reading a session's own account of itself (§26 pattern, ingest.py's discipline).

The numbers say a session produced three pages where fifteen is normal. They
cannot say why. The note can -- "spent the whole time on two problems" -- and
that sentence is often the only place a secondary count exists at all.

Two rules, both inherited from ingest.py and both about refusing to guess.

  The extracted count is RETURNED, never written. A number the model read out of
  a sentence is not yet data; the user confirms it through
  PATCH /api/sessions/{id}/secondary, at which point it is user-supplied. This
  is what lets the mirrored columns carry no per-observation provenance field:
  nothing unconfirmed ever reaches them.

  If the note states no count, return null. Not a plausible one, not one
  inferred from the page count -- null. A fabricated secondary count would flow
  into the density fit, out through the productivity index, and into weekly
  ranking, which is the longest blast radius any invented number here has.
"""

from __future__ import annotations

from typing import Literal

from google.genai import types
from pydantic import BaseModel, Field

from .client import Deadline, generate, max_tokens


class SessionInsight(BaseModel):
    """What one session's numbers and note say, together."""

    observation: str = Field(
        description=(
            "What the numbers alone say about this session, in one sentence. "
            "State it plainly; do not soften a low number or celebrate a high one."
        )
    )
    likely_cause: str = Field(
        description=(
            "Why, read FROM THE NOTE. If the note does not say, write that it "
            "does not say. Never supply a cause the user did not give."
        )
    )
    extracted_secondary_unit: str | None = Field(
        default=None,
        description=(
            "The unit of any count stated in the note, e.g. 'problems'. Null if "
            "the note states no count."
        ),
    )
    extracted_secondary_output: float | None = Field(
        default=None,
        description=(
            "The count stated in the note, e.g. 8 from 'I finished eight "
            "problems'. NULL if the note states no count. Never infer this from "
            "the page count or from how long the session ran."
        ),
    )
    extraction_confidence: Literal["explicit", "inferred", "none"] = Field(
        default="none",
        description=(
            "'explicit' when the note states the number outright. 'inferred' "
            "when it is strongly implied ('did the whole first exercise set'). "
            "'none' when no count was found."
        ),
    )
    metric_switch_worth_reviewing: bool = Field(
        default=False,
        description=(
            "True only if the note suggests the tracked unit is systematically "
            "the wrong measure of this work -- not merely that one session was "
            "unusual."
        ),
    )
    reasoning: str = Field(description="Brief. What in the note led to the above.")


SYSTEM = """\
You read one logged work session for Optimus, a personal planning system with a
single user, and report what it says.

The unit a body of work is tracked in is chosen because its total is knowable --
a book has 380 pages. It is often a poor measure of how much WORK a session
held: a page carrying an hour-long problem is not a page of prose. Your job is
to help tell those apart, using what the user wrote.

The rules below are not style preferences. Violating them corrupts numbers
downstream.

1. NEVER invent a count. If the note does not state how many problems, exercises
   or items were completed, return null. Do not derive one from the page count,
   the duration, or what would be typical. An invented count feeds a regression
   that sets how this work is ranked against everything else the user could do.

2. The cause comes from the NOTE, not from the numbers. "Three pages in fifty
   minutes" does not tell you the user was stuck, distracted, or working hard.
   If the note is silent on why, say that it is silent.

3. Do not reassure. A genuinely poor session reported as a dense one teaches the
   user to ignore you. If the numbers are low and the note offers no reason,
   that is the finding.

4. Recommend reviewing the metric only for a SYSTEMATIC mismatch -- the user
   describing, repeatedly, work the unit cannot see. One unusual session is not
   evidence that the unit is wrong.

5. Be brief. This is read immediately after finishing work, not studied."""


def review_session(
    *,
    note: str,
    unit: str,
    primary_output: float | None,
    typical_output: float | None,
    minutes: float | None,
    secondary_unit: str | None,
    productivity_index: float | None,
    deadline: Deadline | None = None,
) -> SessionInsight:
    """One bounded pass over one session. Persists nothing.

    Uses structured output so the response is schema-valid by construction, the
    same way ingest.py does.
    """
    facts = [
        f"Tracked in: {unit}",
        f"This session: {primary_output if primary_output is not None else 'not recorded'} {unit}",
        f"Typical session: {round(typical_output, 1) if typical_output is not None else 'not established yet'} {unit}",
        f"Duration: {round(minutes) if minutes else 'unknown'} minutes",
    ]
    if secondary_unit:
        facts.append(f"This work also tracks: {secondary_unit}")
    if productivity_index is not None:
        facts.append(
            f"Measured work index: {productivity_index:.2f} "
            "(1.0 = as much work as this user's history predicts for the time spent)"
        )

    response = generate(
        contents=(
            "Here is one session.\n\n"
            + "\n".join(facts)
            + f"\n\nWhat the user wrote about it:\n---\n{note}\n---"
        ),
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM,
            max_output_tokens=max_tokens(),
            response_mime_type="application/json",
            response_schema=SessionInsight,
        ),
        deadline=deadline,
    )
    parsed = response.parsed
    if parsed is None:
        raise RuntimeError("the model returned no parsed session review")
    return parsed
