"""Application settings. Secrets come from the environment, never the repo."""

from __future__ import annotations

import tomllib
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

from optimus.metrics.config import MetricsConfig

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = REPO_ROOT / "config.toml"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="OPTIMUS_", env_file=".env.local")

    database_url: str = "postgresql+psycopg://localhost/optimus"

    # §19: single-user, so one bearer token suffices -- but the app is reachable
    # from the public internet, so this token is the only thing between the
    # world and the data. Generate with secrets.token_urlsafe(32) and set it in
    # the environment. Empty means "refuse every request" rather than "allow".
    auth_token: str = ""

    anthropic_api_key: str = ""

    @property
    def config_path(self) -> Path:
        return CONFIG_PATH


@lru_cache
def get_settings() -> Settings:
    return Settings()


@lru_cache
def get_metrics_config() -> MetricsConfig:
    return MetricsConfig.from_toml(CONFIG_PATH)


@lru_cache
def get_raw_config() -> dict:
    """Sections of config.toml that the engine does not consume ([llm], [interview])."""
    with open(CONFIG_PATH, "rb") as fh:
        return tomllib.load(fh)
