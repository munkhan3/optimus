"""Anthropic client construction and shared request settings."""

from __future__ import annotations

from functools import lru_cache

import anthropic

from ..settings import get_raw_config, get_settings


class LLMUnavailable(RuntimeError):
    """Raised when no API key is configured.

    Surfaced as a 503 rather than silently degrading: a system whose whole
    premise is honest measurement should not quietly substitute a worse answer.
    """


@lru_cache
def get_client() -> anthropic.Anthropic:
    settings = get_settings()
    if not settings.anthropic_api_key:
        raise LLMUnavailable(
            "OPTIMUS_ANTHROPIC_API_KEY is not set; the assistant and ingestion are offline."
        )
    return anthropic.Anthropic(api_key=settings.anthropic_api_key)


def llm_config() -> dict:
    return get_raw_config().get("llm", {})


def model() -> str:
    return llm_config().get("model", "claude-sonnet-5")


def max_tokens() -> int:
    return int(llm_config().get("max_tokens", 16000))
