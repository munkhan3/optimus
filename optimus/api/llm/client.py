"""Gemini client construction and shared request settings.

The provider is Gemini rather than Anthropic because the free tier makes the
intake interview testable without a card. Everything above this module is
provider-agnostic: the routers, the proposal schemas, and the tool handlers do
not know which model answered.

On the free tier Google uses prompts and responses to improve their products.
Enabling billing on the same key stops that and requires no code change --
`model` and the key are the only provider-facing configuration.
"""

from __future__ import annotations

import logging
import time
from functools import lru_cache
from typing import Any

from google import genai
from google.genai import errors as genai_errors
from google.genai import types

log = logging.getLogger(__name__)

from ..settings import get_raw_config, get_settings


class LLMUnavailable(RuntimeError):
    """Raised when no API key is configured.

    Surfaced as a 503 rather than silently degrading: a system whose whole
    premise is honest measurement should not quietly substitute a worse answer.
    """


class LLMTimeout(RuntimeError):
    """Raised when the wall-clock budget ran out before any model answered."""


class Deadline:
    """A wall-clock budget shared across every call that serves one request.

    Retries and model fallback are per-call, but the thing the user is waiting
    on is the whole answer -- and the assistant makes up to `assistant_max_turns`
    calls to produce one. Bounding each call separately multiplies: 8 turns x 4
    models x 3 attempts is 96 requests and ~11 minutes of backoff, which is what
    the assistant was actually doing. One budget, threaded through, cannot.
    """

    def __init__(self, seconds: float) -> None:
        self.expires_at = time.monotonic() + seconds

    @property
    def remaining(self) -> float:
        return self.expires_at - time.monotonic()

    @property
    def expired(self) -> bool:
        return self.remaining <= 0


@lru_cache
def get_client() -> genai.Client:
    settings = get_settings()
    if not settings.gemini_api_key:
        raise LLMUnavailable(
            "OPTIMUS_GEMINI_API_KEY is not set; the assistant and intake are offline."
        )
    return genai.Client(api_key=settings.gemini_api_key)


def llm_config() -> dict:
    return get_raw_config().get("llm", {})


def model() -> str:
    return llm_config().get("model", "gemini-2.5-flash")


def max_tokens() -> int:
    return int(llm_config().get("max_tokens", 16000))


def request_budget_seconds() -> float:
    """How long one user-visible answer may take, in total."""
    return float(llm_config().get("request_budget_seconds", 90))


def _model_chain() -> list[str]:
    cfg = llm_config()
    return [model(), *cfg.get("fallback_models", [])]


def tool_selection_thinking_budget() -> int:
    """Thinking allowed on a turn that only has to pick a tool.

    Measured: one such turn spent 908 thinking tokens and 3.9s to emit a single
    13-token function call -- a third of the whole answer's wall time deciding
    which lookup to run. Choosing a tool is not the part that needs reasoning;
    writing the answer is, and that turn keeps the full budget.
    """
    return int(llm_config().get("tool_selection_thinking_budget", 256))


def _with_thinking(
    config: types.GenerateContentConfig,
    budget: int | None = None,
    include_thoughts: bool = False,
) -> types.GenerateContentConfig:
    """Cap thinking so it cannot consume the whole output budget.

    On Gemini 3.x `max_output_tokens` is shared between thinking and the reply.
    Unbounded, a hard turn can spend the entire budget reasoning and finish with
    `MAX_TOKENS` and an empty candidate -- which surfaces as `response.parsed is
    None`, i.e. "the model returned no parsed turn". Reserving room for the
    answer makes that failure structurally unreachable rather than unlikely.

    `include_thoughts` is opt-in per call site rather than global. It adds
    thought parts to the response, and intake asks for JSON against a
    response_schema -- mixing summary prose into that is a way to break parsing
    for a feature intake cannot use anyway.
    """
    if budget is None:
        budget = llm_config().get("thinking_budget")
    if budget is None or config.thinking_config is not None:
        return config
    return config.model_copy(
        update={
            "thinking_config": types.ThinkingConfig(
                thinking_budget=int(budget), include_thoughts=include_thoughts
            )
        }
    )


def generate(
    *,
    contents: Any,
    config: types.GenerateContentConfig,
    deadline: Deadline | None = None,
    thinking_budget: int | None = None,
    include_thoughts: bool = False,
) -> types.GenerateContentResponse:
    """Call the model, surviving congestion without outliving the user's patience.

    Overload (503) is routine, not exceptional -- and it is not a free-tier
    problem: probing this chain on a prepaid key found two of four models
    congested, twice, minutes apart. A single attempt would make the interview
    fail mid-sentence for reasons that have nothing to do with the user.

    So: retry with backoff, then fall through to the next model in the chain.
    A 404 or a 4xx is NOT retried -- those mean the request is wrong, and
    hammering a wrong request is just slower failure.

    Every wait is checked against `deadline` first. Sleeping through a budget
    that has already expired, or starting an attempt that cannot finish inside
    it, only delays a failure the caller can no longer use.
    """
    cfg = llm_config()
    attempts = int(cfg.get("retry_attempts", 3))
    base = float(cfg.get("retry_base_seconds", 2))
    client = get_client()
    config = _with_thinking(config, thinking_budget, include_thoughts)
    if deadline is None:
        deadline = Deadline(request_budget_seconds())

    last: Exception | None = None
    for name in _model_chain():
        for attempt in range(attempts):
            if deadline.expired:
                # `last` is None when nothing errored and the models were merely
                # slow, which is a different diagnosis and should not read as a
                # missing error.
                raise LLMTimeout(
                    "the model did not finish in time. "
                    + (f"Last error: {last}" if last else "No model returned an error; they were too slow.")
                ) from last
            try:
                return client.models.generate_content(
                    model=name, contents=contents, config=config
                )
            except genai_errors.ServerError as exc:
                last = exc
                nap = base * (2**attempt)
                if attempt < attempts - 1 and deadline.remaining > nap:
                    time.sleep(nap)
                    continue
                log.warning("%s exhausted retries (%s); trying next model", name, exc)
                break
            except genai_errors.ClientError as exc:
                # Wrong model id, bad schema, bad key. Retrying cannot help, but
                # another model in the chain might be valid where this one is not.
                last = exc
                log.warning("%s rejected the request (%s); trying next model", name, exc)
                break

    raise RuntimeError(
        f"every model in {_model_chain()} failed. Last error: {last}"
    ) from last


def generate_stream(
    *,
    contents: Any,
    config: types.GenerateContentConfig,
    deadline: Deadline | None = None,
    thinking_budget: int | None = None,
    include_thoughts: bool = False,
) -> Any:
    """`generate`, delivered in chunks as the model produces them.

    Retry and model fallback work exactly as they do in `generate`, but only up
    to the first chunk. Once a chunk has been handed to the caller it is already
    on the user's screen, and quietly restarting on another model would rewrite
    text they have read. Before that point nothing is visible and a retry is
    free, which covers the 503s that make the chain necessary in the first place.
    """
    cfg = llm_config()
    attempts = int(cfg.get("retry_attempts", 3))
    base = float(cfg.get("retry_base_seconds", 2))
    client = get_client()
    config = _with_thinking(config, thinking_budget, include_thoughts)
    if deadline is None:
        deadline = Deadline(request_budget_seconds())

    last: Exception | None = None
    for name in _model_chain():
        for attempt in range(attempts):
            if deadline.expired:
                raise LLMTimeout(
                    "the model did not finish in time. "
                    + (f"Last error: {last}" if last else "No model returned an error; they were too slow.")
                ) from last
            delivered = False
            try:
                for chunk in client.models.generate_content_stream(
                    model=name, contents=contents, config=config
                ):
                    delivered = True
                    yield chunk
                return
            except (genai_errors.ServerError, genai_errors.ClientError) as exc:
                last = exc
                if delivered:
                    # Past the point of no return: the user is reading this.
                    raise
                if isinstance(exc, genai_errors.ServerError):
                    nap = base * (2**attempt)
                    if attempt < attempts - 1 and deadline.remaining > nap:
                        time.sleep(nap)
                        continue
                log.warning("%s failed to stream (%s); trying next model", name, exc)
                break

    raise RuntimeError(
        f"every model in {_model_chain()} failed. Last error: {last}"
    ) from last


def truncated(response: types.GenerateContentResponse) -> bool:
    """Whether the model ran out of output budget mid-answer."""
    candidate = response.candidates[0] if response.candidates else None
    finish = getattr(candidate, "finish_reason", None)
    return finish is not None and str(finish).endswith("MAX_TOKENS")


def to_contents(history: list[dict[str, Any]]) -> list[types.Content]:
    """Convert the API's transcript format into Gemini's.

    The wire format stays `role: user | assistant` because the frontend and the
    tests are written against it, and it should not churn if the provider
    changes again. Gemini calls the other side "model"; that rename is an
    implementation detail and belongs here rather than leaking outward.
    """
    out: list[types.Content] = []
    for message in history:
        content = message.get("content")
        if not isinstance(content, str):
            continue
        out.append(
            types.Content(
                role="model" if message.get("role") == "assistant" else "user",
                parts=[types.Part(text=content)],
            )
        )
    return out
