"""Attach authorized media references to Sophia's model request."""

from __future__ import annotations

from google.adk.models.llm_request import LlmRequest
from google.genai import types

from .agent_models import MediaEvidence


def attach_media_evidence(callback_context, llm_request: LlmRequest):
    raw = callback_context.state.get("media_evidence")
    if not raw:
        return None
    evidence = MediaEvidence.model_validate(raw)
    parts: list[types.Part] = []
    if evidence.video_uri:
        parts.append(types.Part(file_data=types.FileData(
            file_uri=evidence.video_uri,
            mime_type="video/mp4",
        )))
    if evidence.audio_uri:
        parts.append(types.Part(file_data=types.FileData(
            file_uri=evidence.audio_uri,
            mime_type="audio/mp4",
        )))
    for frame in evidence.frames:
        parts.append(types.Part(file_data=types.FileData(
            file_uri=frame.uri,
            mime_type="image/jpeg",
            display_name=frame.id,
        )))
    if parts:
        llm_request.contents.append(types.Content(role="user", parts=parts))
    return None
