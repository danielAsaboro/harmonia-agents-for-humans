"""Deployable Vertex AI Agent Engine application for Harmonia cognition."""

from __future__ import annotations

import os
from typing import Any

from google.adk.models.base_llm import BaseLlm

from .agents import build_agent_team


def build_agent_engine_app(
    *,
    adk_app_type: type[Any] | None = None,
    model: str | BaseLlm | None = None,
    vertex_location: str | None = None,
) -> Any:
    if adk_app_type is None:
        from vertexai.agent_engines import AdkApp

        adk_app_type = AdkApp
    from google.adk.apps import App

    if vertex_location and model is not None:
        raise ValueError("vertex_location cannot be combined with an explicit model")
    previous_provider = os.environ.get("GOOGLE_GENAI_USE_VERTEXAI")
    previous_location = os.environ.get("GEMINI_VERTEX_LOCATION")
    try:
        if vertex_location:
            # Agent Engine serializes this hierarchy during deployment. Pin the
            # provider before model instances are constructed; runtime env vars
            # cannot rewrite already-serialized Gemini.client_kwargs.
            os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "true"
            os.environ["GEMINI_VERTEX_LOCATION"] = vertex_location
        root_agent = build_agent_team(model=model)
    finally:
        for key, prior in (
            ("GOOGLE_GENAI_USE_VERTEXAI", previous_provider),
            ("GEMINI_VERTEX_LOCATION", previous_location),
        ):
            if prior is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = prior
    return adk_app_type(app=App(
        name="harmonia",
        root_agent=root_agent,
    ))


# Agent Engine source deployments can use entrypoint object `app`.
def __getattr__(name: str) -> Any:
    if name == "app":
        return build_agent_engine_app()
    raise AttributeError(name)
