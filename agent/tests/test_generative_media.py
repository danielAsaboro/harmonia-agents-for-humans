"""Veo/Lyria provider contracts, resumption, and failure semantics."""

from __future__ import annotations

import pytest

from harmonia_agent.generative_media import (
    LyriaGenerator,
    MediaOperationPending,
    MediaProtocolError,
    VeoGenerator,
    estimate_media_cost,
    validate_lyria_request,
    validate_veo_request,
)
from harmonia_agent.stages import classify_failure


class FakeTransport:
    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.veo_done = True

    def start_veo(self, **kwargs):
        self.calls.append(("start", kwargs))
        return {"name": "projects/p/locations/us-central1/models/veo/operations/op-1"}

    def poll_veo(self, operation_name: str, model: str):
        self.calls.append(("poll", operation_name, model))
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
        request=validate_veo_request({"modelCapability": "veo-3.1-fast", "mode": "text_to_video", "prompt": "abstract startup dashboard motion", "durationSec": 4, "aspectRatio": "9:16", "resolution": "1080p", "generateAudio": False, "enhancePrompt": True, "outputCount": 1}),
        existing_operation=None,
        persist_operation=lambda name: order.append(f"persist:{name}"),
    )

    assert result.data == b"video"
    assert result.mime == "video/mp4"
    assert result.model == "veo-3.1-fast-generate-001"
    assert order == ["persist:projects/p/locations/us-central1/models/veo/operations/op-1"]
    assert [call[0] for call in transport.calls] == ["start", "poll"]
    assert transport.calls[1][2] == "veo-3.1-fast-generate-001"


def test_veo_resumes_existing_operation_without_starting_a_duplicate():
    transport = FakeTransport()
    transport.veo_done = False
    with pytest.raises(MediaOperationPending, match="op-1"):
        VeoGenerator(transport=transport).generate(
            request=validate_veo_request({"modelCapability": "veo-3.1-fast", "mode": "text_to_video", "prompt": "abstract startup dashboard motion", "durationSec": 4, "aspectRatio": "9:16", "resolution": "1080p", "generateAudio": False, "enhancePrompt": True, "outputCount": 1}),
            existing_operation="operations/op-1",
            persist_operation=lambda _: pytest.fail("must not persist twice"),
        )
    assert transport.calls == [("poll", "operations/op-1", "veo-3.1-fast-generate-001")]


def test_lyria_returns_one_bounded_audio_clip_and_provider_interaction_id():
    result = LyriaGenerator(transport=FakeTransport()).generate(
        request=validate_lyria_request({"modelCapability": "lyria-3-clip", "prompt": "instrumental optimistic technology pulse", "instrumental": True, "lyricsMode": "none", "language": "en", "targetDurationSec": 30, "outputCount": 1}),
        estimated_cost_usd="0.120000",
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
        LyriaGenerator(transport=EmptyLyria()).generate(request=validate_lyria_request({"modelCapability": "lyria-3-clip", "prompt": "pulse", "instrumental": True, "lyricsMode": "none", "language": "en", "targetDurationSec": 30, "outputCount": 1}), estimated_cost_usd="0.120000")


def test_media_pending_is_retryable_but_malformed_output_is_permanent():
    assert classify_failure(MediaOperationPending("operations/op-1")) is False
    assert classify_failure(MediaProtocolError("bad media")) is True


def test_catalog_validates_provider_capabilities_before_spend():
    request = validate_veo_request({
        "modelCapability": "veo-3.1-fast", "mode": "text_to_video", "prompt": "blue network",
        "durationSec": 4, "aspectRatio": "9:16", "resolution": "1080p",
        "generateAudio": False, "enhancePrompt": True, "outputCount": 1,
    })
    assert estimate_media_cost(request) == "0.320000"
    with pytest.raises(MediaProtocolError, match="resolution"):
        validate_veo_request({**request, "resolution": "4k"})


def test_preview_lyria_requires_deployment_pricing_and_rejects_invalid_instrumental_lyrics():
    request = validate_lyria_request({
        "modelCapability": "lyria-3-clip", "prompt": "warm minimal pulse", "instrumental": True,
        "lyricsMode": "none", "language": "en", "targetDurationSec": 30, "outputCount": 1,
    })
    with pytest.raises(MediaProtocolError, match="pricing unavailable"):
        estimate_media_cost(request)
    assert estimate_media_cost(request, {"lyria-3-clip": "0.120000"}) == "0.120000"
    with pytest.raises(MediaProtocolError, match="lyrics"):
        validate_lyria_request({**request, "lyricsMode": "provided", "providedLyrics": "hello"})


def test_unwired_conditioning_and_music_controls_are_not_advertised_as_executable():
    base_video = {"modelCapability": "veo-3.1-fast", "prompt": "blue network", "durationSec": 6, "aspectRatio": "16:9", "resolution": "1080p", "generateAudio": True, "enhancePrompt": False, "outputCount": 1}
    with pytest.raises(MediaProtocolError, match="mode"):
        validate_veo_request({**base_video, "mode": "image_to_video", "sourceImageArtifactId": "image-1"})
    with pytest.raises(MediaProtocolError, match="conditioning|controls"):
        validate_lyria_request({"modelCapability": "lyria-3-clip", "prompt": "pulse", "conditioningImageArtifactId": "image-1", "instrumental": True, "lyricsMode": "none", "language": "en", "targetDurationSec": 30, "outputCount": 1})
