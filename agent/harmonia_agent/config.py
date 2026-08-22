"""Harmonia ADK worker service configuration (12-factor environment)."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing required environment variable: {name}")
    return value


@dataclass(frozen=True)
class Settings:
    web_internal_url: str
    internal_api_token: str
    model_id: str
    gemini_api_key: str | None
    github_token: str | None
    gcp_project: str
    operator_token: str | None
    telegram_bot_token: str | None
    telegram_allowed_chat_id: str | None

    @classmethod
    def load(cls) -> "Settings":
        gemini_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        return cls(
            web_internal_url=_require("WEB_INTERNAL_URL").rstrip("/"),
            internal_api_token=_require("INTERNAL_API_TOKEN"),
            model_id=os.environ.get("MODEL_ID", "gemini-3.5-flash"),
            gemini_api_key=gemini_key,
            github_token=os.environ.get("GITHUB_TOKEN"),
            gcp_project=os.environ.get("GOOGLE_CLOUD_PROJECT", "harmonia-local"),
            operator_token=os.environ.get("OPERATOR_TOKEN") or None,
            telegram_bot_token=os.environ.get("TELEGRAM_BOT_TOKEN") or None,
            telegram_allowed_chat_id=os.environ.get("TELEGRAM_ALLOWED_CHAT_ID") or None,
        )


_settings: Settings | None = None


def settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings.load()
    return _settings


def reset_settings_for_tests() -> None:
    global _settings
    _settings = None
