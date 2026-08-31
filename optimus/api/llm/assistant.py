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
from collections.abc import Iterator
from typing import Any

from google.genai import types
from sqlmodel import Session

from ..settings import get_raw_config
from .client import (
    Deadline,
    generate_stream,
    max_tokens,
    request_budget_seconds,
    to_contents,
    tool_selection_thinking_budget,
)
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

- DO NOT LOOK UP WHAT YOU ALREADY HAVE. Before calling a tool, check whether an
  earlier result in this conversation already carries the field. get_goal_state
  returns feasibility, health, pace, required_pace, drift and projection for
  every trackable, so a follow-up get_feasibility or get_pace on the same
  trackable buys nothing and costs the user a full round trip. Prefer one broad
  call to several narrow ones, and when you do need several independent tools,
  request them together in a single turn rather than one per turn.

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


FINAL_TURN_RULE = """

You have no tools available on this turn. Answer now from what you have already
looked up. Do not say you need to check something -- say what the data you have
shows, and name anything you could not determine."""

# Below this much remaining budget, stop looking things up and answer. One more
# tool round trip costs more than it is worth if the answer never gets sent.
FINAL_TURN_RESERVE_SECONDS = 20.0


def ask_stream(
    db: Session,
    question: str,
    history: list[dict] | None = None,
    deadline: Deadline | None = None,
) -> Iterator[dict]:
    """Run one assistant turn, emitting an event as each tool runs.

    Yields `{"type": "tool", ...}` per executed call and finally one
    `{"type": "answer", ...}`.

    Emitting rather than accumulating is what keeps the connection alive. The
    caller holds a single HTTP request open for this whole loop, and WebKit's
    request timeout measures silence, not duration -- it resets on every byte
    received. A loop that says nothing for its first 60 seconds gets killed by
    the browser no matter how good the answer would have been; one that reports
    each tool as it runs never approaches the limit.

    It also happens to be the honest presentation. P3 asks that the assistant's
    sourcing be visible, and watching the lookups happen shows more than a list
    of tool names appended after the fact.

    Automatic function calling is disabled deliberately. The handlers need a
    request-scoped database session, and letting the SDK invoke bare callables
    would mean either a global session or a hidden one -- both worse than
    running the loop here where the session's lifetime is obvious.
    """
    turn_limit = int(get_raw_config().get("llm", {}).get("assistant_max_turns", 8))
    if deadline is None:
        deadline = Deadline(request_budget_seconds())

    contents = to_contents(history or [])
    contents.append(types.Content(role="user", parts=[types.Part(text=question)]))

    tool_calls: list[dict[str, Any]] = []

    for turn in range(turn_limit):
        # Withhold the tools on the last pass, or when too little budget is left
        # to survive another round trip. Offered tools, the model keeps looking
        # things up until the loop cuts it off and the user gets an apology
        # instead of an answer -- which is what "I ran out of tool-use turns"
        # was: eight successful lookups thrown away for want of a ninth turn to
        # say what they showed. With no tools available it must answer from what
        # it has, which after eight lookups is plenty.
        final = turn == turn_limit - 1 or deadline.remaining < FINAL_TURN_RESERVE_SECONDS
        config = types.GenerateContentConfig(
            system_instruction=SYSTEM if not final else SYSTEM + FINAL_TURN_RULE,
            max_output_tokens=max_tokens(),
            tools=(
                None if final else [types.Tool(function_declarations=TOOL_DECLARATIONS)]
            ),
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        )

        # Stream every turn, not just the closing one. Which turn produces the
        # answer is not knowable in advance -- the model stops calling tools
        # whenever it has enough, and that is usually well before the turn limit.
        # Streaming only the forced-final turn would leave the common case
        # arriving all at once, which is the thing this is meant to fix.
        #
        # The closing turn also gets its own budget rather than the remains of
        # the shared one, which by definition may already be spent: a single slow
        # call can overrun the reserve, and refusing to spend a few more seconds
        # there would throw away every lookup already paid for and leave the user
        # with an error after a minute of visible work.
        parts: list[Any] = []
        # Streamed text arrives as deltas and must be concatenated, not joined.
        # _text_of puts a newline between parts, which is right for the whole
        # parts of a non-streamed response and wrong here: it would insert a
        # break at every chunk boundary, so the answer the user read while it
        # streamed would not match the one recorded at the end.
        streamed: list[str] = []
        stop = "unknown"
        for chunk in generate_stream(
            contents=contents,
            config=config,
            deadline=Deadline(FINAL_TURN_RESERVE_SECONDS) if final else deadline,
            # A turn that only picks a tool gets a fraction of the reasoning the
            # answer turn gets; see tool_selection_thinking_budget.
            thinking_budget=None if final else tool_selection_thinking_budget(),
            # Thought summaries exist to fill the silence before the first real
            # word, so they are only worth asking for while the user is waiting.
            include_thoughts=True,
        ):
            candidate = chunk.candidates[0] if chunk.candidates else None
            if candidate is None:
                continue
            if candidate.finish_reason is not None:
                stop = str(candidate.finish_reason)
            for part in list(candidate.content.parts or []) if candidate.content else []:
                parts.append(part)
                if not getattr(part, "text", None):
                    continue
                if getattr(part, "thought", False):
                    # The model's own summary of what it is working out. Shown to
                    # fill the several seconds before the first word of the
                    # answer, and deliberately kept OUT of `streamed`: the answer
                    # must stay exactly what the user watched being written.
                    yield {"type": "thinking", "text": part.text}
                    continue
                # Non-thought text arriving before a tool call is a preamble
                # rather than the answer. It is still worth showing -- it is the
                # earliest sign of life -- and the client drops it once a tool runs.
                streamed.append(part.text)
                yield {"type": "token", "text": part.text}

        calls = [p.function_call for p in parts if getattr(p, "function_call", None)]

        if not calls:
            yield {
                "type": "answer",
                "answer": "".join(streamed).strip(),
                "stop_reason": stop,
                "tool_calls": tool_calls,
                "history": _serializable(contents),
            }
            return

        contents.append(types.Content(role="model", parts=parts))

        # Execute every requested call and return all results in ONE turn --
        # splitting them trains the model out of calling tools in parallel.
        results = []
        for call in calls:
            args = dict(call.args or {})
            output = dispatch(db, call.name, args)
            tool_calls.append({"name": call.name, "input": args})
            yield {"type": "tool", "name": call.name, "input": args}
            results.append(
                types.Part.from_function_response(
                    name=call.name,
                    response={"result": json.loads(json.dumps(output, default=str))},
                )
            )
        contents.append(types.Content(role="user", parts=results))

    yield {
        "type": "answer",
        "answer": (
            "I ran out of tool-use turns before reaching an answer. "
            "Try asking something narrower."
        ),
        "stop_reason": "max_turns",
        "tool_calls": tool_calls,
    }


def ask(db: Session, question: str, history: list[dict] | None = None) -> dict:
    """The whole answer at once, for callers that cannot stream.

    Kept because the non-streaming endpoint and the tests are written against
    it. It is the same loop; only the delivery differs.
    """
    last: dict[str, Any] = {}
    for event in ask_stream(db, question, history):
        if event["type"] == "answer":
            last = {k: v for k, v in event.items() if k != "type"}
    return last


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
