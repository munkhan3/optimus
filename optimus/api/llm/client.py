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


def _model_chain() -> list[str]:
    cfg = llm_config()
    return [model(), *cfg.get("fallback_models", [])]


def generate(*, contents: Any, config: types.GenerateContentConfig) -> types.GenerateContentResponse:
    """Call the model, surviving free-tier congestion.

    Overload (503) is a routine condition on the free tier, not an exceptional
    one -- probing five models found three congested at the same moment. A
    single attempt would make the interview fail in the middle of a sentence
    for reasons that have nothing to do with the user.

    So: retry with backoff, then fall through to the next model in the chain.
    A 404 or a 4xx is NOT retried -- those mean the request is wrong, and
    hammering a wrong request is just slower failure.
    """
    cfg = llm_config()
    attempts = int(cfg.get("retry_attempts", 3))
    base = float(cfg.get("retry_base_seconds", 2))
    client = get_client()

    last: Exception | None = None
    for name in _model_chain():
        for attempt in range(attempts):
            try:
                return client.models.generate_content(
                    model=name, contents=contents, config=config
                )
            except genai_errors.ServerError as exc:
                last = exc
                if attempt < attempts - 1:
                    time.sleep(base * (2**attempt))
                    continue
                log.warning("%s exhausted retries (%s); trying next model", name, exc)
            except genai_errors.ClientError as exc:
                # Wrong model id, bad schema, bad key. Retrying cannot help, but
                # another model in the chain might be valid where this one is not.
                last = exc
                log.warning("%s rejected the request (%s); trying next model", name, exc)
                break

    raise RuntimeError(
        f"every model in {_model_chain()} failed. Last error: {last}"
    ) from last


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
