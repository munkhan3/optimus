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

from sqlmodel import Session

from ..settings import get_raw_config
from .client import get_client, max_tokens, model
from .tools import TOOL_SCHEMAS, dispatch

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


def _blocks_to_text(content: list[Any]) -> str:
    return "\n".join(b.text for b in content if getattr(b, "type", None) == "text").strip()


def ask(db: Session, question: str, history: list[dict] | None = None) -> dict:
    """Run one assistant turn, executing read-only tools until it answers.

    Returns the answer plus a transcript of which tools ran, so the user can
    check what the answer was actually based on (P3). An assistant whose
    sourcing is invisible is one more thing to take on faith.
    """
    client = get_client()
    turn_limit = int(get_raw_config().get("llm", {}).get("assistant_max_turns", 8))

    messages: list[dict[str, Any]] = list(history or [])
    messages.append({"role": "user", "content": question})

    tool_calls: list[dict[str, Any]] = []

    for _turn in range(turn_limit):
        response = client.messages.create(
            model=model(),
            max_tokens=max_tokens(),
            system=SYSTEM,
            thinking={"type": "adaptive"},
            tools=TOOL_SCHEMAS,
            messages=messages,
        )

        if response.stop_reason == "refusal":
            return {
                "answer": "The request was declined by a safety classifier.",
                "stop_reason": "refusal",
                "tool_calls": tool_calls,
            }

        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason != "tool_use":
            return {
                "answer": _blocks_to_text(response.content),
                "stop_reason": response.stop_reason,
                "tool_calls": tool_calls,
                "history": _serializable(messages),
            }

        # Execute every requested tool and return all results in ONE user
        # message -- splitting them trains the model out of parallel calls.
        results = []
        for block in response.content:
            if getattr(block, "type", None) != "tool_use":
                continue
            output = dispatch(db, block.name, dict(block.input))
            tool_calls.append({"name": block.name, "input": dict(block.input)})
            results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": json.dumps(output, default=str),
                "is_error": isinstance(output, dict) and "error" in output,
            })
        messages.append({"role": "user", "content": results})

    return {
        "answer": (
            "I ran out of tool-use turns before reaching an answer. "
            "Try asking something narrower."
        ),
        "stop_reason": "max_turns",
        "tool_calls": tool_calls,
    }


def _serializable(messages: list[dict]) -> list[dict]:
    """Strip SDK objects so the history can round-trip through JSON."""
    out = []
    for message in messages:
        content = message["content"]
        if isinstance(content, str) or isinstance(content, list) and all(isinstance(c, dict) for c in content):
            out.append({"role": message["role"], "content": content})
        else:
            out.append({
                "role": message["role"],
                "content": [
                    b.model_dump() if hasattr(b, "model_dump") else b for b in content
                ],
            })
    return out
