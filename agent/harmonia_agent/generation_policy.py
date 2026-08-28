"""Translate Harmonia's provider-neutral role policy into Google Gen AI config."""

from __future__ import annotations

from google.genai import types

from .role_models import RoleModelConfig

_STANDARD_SAFETY_CATEGORIES = (
    types.HarmCategory.HARM_CATEGORY_HARASSMENT,
    types.HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    types.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    types.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
)


def safety_settings(profile: str) -> list[types.SafetySetting]:
    """Resolve a named Harmonia safety profile or fail closed."""
    if profile != "harmonia-standard":
        raise ValueError(f"unknown safety profile: {profile}")
    return [
        types.SafetySetting(
            category=category,
            threshold=types.HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        )
        for category in _STANDARD_SAFETY_CATEGORIES
    ]


def generation_config(role: RoleModelConfig) -> types.GenerateContentConfig:
    """Build the concrete request configuration for a cognitive role."""
    policy = role.generation
    return types.GenerateContentConfig(
        temperature=policy.temperature,
        top_p=policy.top_p,
        top_k=policy.top_k,
        max_output_tokens=role.max_output_tokens,
        safety_settings=safety_settings(policy.safety_profile),
        http_options=types.HttpOptions(
            timeout=role.timeout_seconds * 1_000,
            retry_options=types.HttpRetryOptions(
                attempts=2,
                initial_delay=1,
                max_delay=8,
                exp_base=2,
                jitter=0.2,
                http_status_codes=[429, 500, 502, 503, 504],
            ),
        ),
    )
