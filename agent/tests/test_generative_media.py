"""Veo/Lyria provider contracts, resumption, and failure semantics."""

from __future__ import annotations

import pytest

from harmonia_agent.generative_media import (
    LyriaGenerator,
    MediaOperationPending,
    MediaProtocolError,
    VeoGenerator,
)
from harmonia_agent.stages import classify_failure


class FakeTransport:
    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.veo_done = True

    def start_veo(self, **kwargs):
        self.calls.append(("start", kwargs))
        return {"name": "projects/p/locations/us-central1/models/veo/operations/op-1"}

    def poll_veo(self, operation_name: str):
        self.calls.append(("poll", operation_name))
        if not self.veo_done:
            return {"name": operation_name, "done": False}
        return {"name": operation_name, "done": True, "response": {"videos": [{
            "bytesBase64Encoded": "dmlkZW8=", "mimeType": "video/mp4",
        }]}}

    def generate_lyria(self, **kwargs):
        self.calls.append(("lyria", kwargs))
        return {"id": "interaction-1", "status": "completed", "outputs": [{
            "type": "audio", "mime_type": "audio/mpeg", "data": "YXVkaW8=",
        }]}


def test_veo_persists_operation_before_polling_and_returns_typed_media():
    transport = FakeTransport()
    order: list[str] = []

    result = VeoGenerator(transport=transport).generate(
        prompt="abstract startup dashboard motion",
        duration_sec=4,
        aspect_ratio="9:16",
        existing_operation=None,
        persist_operation=lambda name: order.append(f"persist:{name}"),
    )

    assert result.data == b"video"
    assert result.mime == "video/mp4"
    assert result.model == "veo-3.1-fast-generate-001"
    assert order == ["persist:projects/p/locations/us-central1/models/veo/operations/op-1"]
    assert [call[0] for call in transport.calls] == ["start", "poll"]


def test_veo_resumes_existing_operation_without_starting_a_duplicate():
    transport = FakeTransport()
    transport.veo_done = False
    with pytest.raises(MediaOperationPending, match="op-1"):
        VeoGenerator(transport=transport).generate(
            prompt="abstract startup dashboard motion",
            duration_sec=4,
            aspect_ratio="9:16",
            existing_operation="operations/op-1",
            persist_operation=lambda _: pytest.fail("must not persist twice"),
        )
    assert transport.calls == [("poll", "operations/op-1")]


def test_lyria_returns_one_bounded_audio_clip_and_provider_interaction_id():
    result = LyriaGenerator(transport=FakeTransport()).generate(
        prompt="instrumental optimistic technology pulse", duration_sec=30,
    )
    assert result.data == b"audio"
    assert result.mime == "audio/mpeg"
    assert result.model == "lyria-3-clip-preview"
    assert result.provider_id == "interaction-1"


def test_media_generators_reject_malformed_success_without_fallback():
    class EmptyLyria(FakeTransport):
        def generate_lyria(self, **kwargs):
            return {"status": "completed", "outputs": []}

    with pytest.raises(MediaProtocolError, match="audio"):
        LyriaGenerator(transport=EmptyLyria()).generate(prompt="pulse", duration_sec=30)


def test_media_pending_is_retryable_but_malformed_output_is_permanent():
    assert classify_failure(MediaOperationPending("operations/op-1")) is False
    assert classify_failure(MediaProtocolError("bad media")) is True
