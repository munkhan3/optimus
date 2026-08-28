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

from functools import lru_cache
from typing import Any

from google import genai
from google.genai import types

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
