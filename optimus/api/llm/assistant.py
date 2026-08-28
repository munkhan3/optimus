"""The read-only assistant (§26), and the boundary it must not cross.

§25.6 and P3 are the load-bearing constraints here: the primary reason for any
recommendation is generated deterministically from score_breakdown, never by
this model. The assistant elaborates conversationally on top of a line the
system already produced.

That ordering is not cosmetic. If the model produced the reason, the reason
could drift from the arithmetic that actually ranked the item, and the user
would be calibrating their trust against a story rather than the system. When
the two disagree, the stored breakdown is right and the model is wrong.
"""

from __future__ import annotations

import json
from typing import Any

from google.genai import types
from sqlmodel import Session

from ..settings import get_raw_config
from .client import get_client, max_tokens, model, to_contents
from .tools import TOOL_DECLARATIONS, dispatch

SYSTEM = """\
You are the assistant inside Optimus, a personal planning system with one user.

You have read-only tools over the user's real data. You cannot change anything --
there are no write tools, deliberately. If the user asks you to change a
deadline, cut scope, add sessions, or log work, explain what you would change
and tell them where to do it. Never claim to have done it.

How to be useful here:

- ANSWER FROM THE TOOLS, NOT FROM MEMORY. If you have not looked it up this
  turn, look it up. Never estimate a number the tools can give you exactly.

- The system already generates the primary reason for every recommendation from
  its stored score breakdown. Your job is to elaborate on that reason, not to
  invent a competing one. When you explain a ranking, decompose it into the
  components the breakdown actually contains.

- Distinguish measured from estimated. A pace with basis 'prior_only' is the
  user's own guess with no evidence behind it; say so. A value marked
  'model_estimated' was inferred and has an open gap against it. An interval
  marked provisional is not yet trustworthy.

- Never present an unknown as a zero or as fine. If feasibility is null it is
  UNDETERMINED, which is not the same as feasible.

- Self-assessed progress is a review signal only. Never treat a milestone the
  user has sliddered to 80% as therefore healthy, and never use that number to
  argue about pace, feasibility, or priority.

- Pace ratio is not comparable across goals. A goal at 0.7 may simply have had
  an aggressive plan. What compares across goals is feasibility: whether the
  remaining work still fits before its deadline.

- When a plan is impossible, say so plainly. Do not soften it, and do not
  suggest moving the deadline as the obvious fix -- that is the drift this
  system exists to prevent. The four options are: add sessions (from another
  goal's budget, and say what it costs), cut scope, move the deadline, or
  declare it infeasible.

Be concise and concrete. Cite the actual numbers."""


def ask(db: Session, question: str, history: list[dict] | None = None) -> dict:
    """Run one assistant turn, executing read-only tools until it answers.

    Returns the answer plus a transcript of which tools ran, so the user can
    check what the answer was actually based on (P3). An assistant whose
    sourcing is invisible is one more thing to take on faith.

    Automatic function calling is disabled deliberately. The handlers need a
    request-scoped database session, and letting the SDK invoke bare callables
    would mean either a global session or a hidden one -- both worse than
    running the loop here where the session's lifetime is obvious.
    """
    client = get_client()
    turn_limit = int(get_raw_config().get("llm", {}).get("assistant_max_turns", 8))

    contents = to_contents(history or [])
    contents.append(types.Content(role="user", parts=[types.Part(text=question)]))

    tool_calls: list[dict[str, Any]] = []

    for _turn in range(turn_limit):
        response = client.models.generate_content(
            model=model(),
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM,
                max_output_tokens=max_tokens(),
                tools=[types.Tool(function_declarations=TOOL_DECLARATIONS)],
                automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
            ),
        )

        candidate = response.candidates[0] if response.candidates else None
        parts = list(candidate.content.parts) if candidate and candidate.content else []
        calls = [p.function_call for p in parts if getattr(p, "function_call", None)]

        if not calls:
            return {
                "answer": _text_of(parts),
                "stop_reason": str(candidate.finish_reason) if candidate else "unknown",
                "tool_calls": tool_calls,
                "history": _serializable(contents),
            }

        contents.append(types.Content(role="model", parts=parts))

        # Execute every requested call and return all results in ONE turn --
        # splitting them trains the model out of calling tools in parallel.
        results = []
        for call in calls:
            args = dict(call.args or {})
            output = dispatch(db, call.name, args)
            tool_calls.append({"name": call.name, "input": args})
            results.append(
                types.Part.from_function_response(
                    name=call.name,
                    response={"result": json.loads(json.dumps(output, default=str))},
                )
            )
        contents.append(types.Content(role="user", parts=results))

    return {
        "answer": (
            "I ran out of tool-use turns before reaching an answer. "
            "Try asking something narrower."
        ),
        "stop_reason": "max_turns",
        "tool_calls": tool_calls,
    }


def _text_of(parts: list) -> str:
    return "\n".join(p.text for p in parts if getattr(p, "text", None)).strip()


def _serializable(contents: list) -> list[dict]:
    """Back to the wire format, which stays provider-neutral."""
    out: list[dict] = []
    for content in contents:
        text = _text_of(list(content.parts or []))
        if text:
            out.append({
                "role": "assistant" if content.role == "model" else "user",
                "content": text,
            })
    return out
