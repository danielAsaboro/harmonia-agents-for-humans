from __future__ import annotations

from types import SimpleNamespace

import pytest
from google.adk.models.llm_request import LlmRequest
from google.genai import types
from pydantic import ValidationError

from harmonia_agent.agent_models import FrameEvidence, MediaEvidence
from harmonia_agent.multimodal import attach_media_evidence


def test_media_evidence_rejects_frames_outside_duration():
    with pytest.raises(ValidationError, match="duration"):
        MediaEvidence(
            video_uri="https://www.youtube.com/watch?v=abc12345678",
            duration_sec=30,
            source_digest="a" * 64,
            frames=[FrameEvidence(
                id="f1",
                uri="gs://bucket/f.jpg",
                timestamp_sec=31,
                digest="b" * 64,
            )],
        )


def test_media_evidence_rejects_duplicate_frame_ids():
    frame = {
        "id": "f1", "uri": "gs://bucket/f.jpg", "timestamp_sec": 3, "digest": "b" * 64,
    }
    with pytest.raises(ValidationError, match="unique"):
        MediaEvidence(
            video_uri="https://www.youtube.com/watch?v=abc12345678",
            duration_sec=30,
            source_digest="a" * 64,
            frames=[frame, frame],
        )


def test_callback_attaches_real_video_part_without_persisting_bytes():
    request = LlmRequest(
        contents=[types.Content(role="user", parts=[types.Part(text="analyze")])],
    )
    state = {
        "media_evidence": {
            "video_uri": "https://www.youtube.com/watch?v=abc12345678",
            "duration_sec": 60,
            "source_digest": "a" * 64,
            "frames": [],
        },
    }

    result = attach_media_evidence(SimpleNamespace(state=state), request)

    assert result is None
    attached = request.contents[-1].parts[0]
    assert attached.file_data.file_uri.startswith("https://www.youtube.com/")
    assert attached.file_data.mime_type == "video/mp4"
    assert attached.inline_data is None
