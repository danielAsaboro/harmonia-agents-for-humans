"""Approval-gated Veo and Lyria provider adapters with resumable operations."""

from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any, Callable, Protocol

import google.auth
from google.auth.transport.requests import Request
import httpx

from .telemetry import safe_attributes, tracer

VEO_MODEL = "veo-3.1-fast-generate-001"
LYRIA_MODEL = "lyria-3-clip-preview"


class MediaProtocolError(RuntimeError):
    """A media provider returned a malformed or policy-filtered success."""


class MediaProviderError(RuntimeError):
    """Transport/provider failure, with retry classification."""

    def __init__(self, message: str, *, permanent: bool = False) -> None:
        super().__init__(message)
        self.permanent = permanent


class MediaOperationPending(MediaProviderError):
    def __init__(self, operation_name: str) -> None:
        super().__init__(f"media operation is still pending: {operation_name}")
        self.operation_name = operation_name


@dataclass(frozen=True)
class GeneratedMedia:
    data: bytes
    mime: str
    model: str
    provider_id: str
    duration_sec: int
    estimated_cost_usd: str


class MediaTransport(Protocol):
    def start_veo(self, **kwargs: Any) -> dict[str, Any]: ...

    def poll_veo(self, operation_name: str) -> dict[str, Any]: ...

    def generate_lyria(self, **kwargs: Any) -> dict[str, Any]: ...


class GoogleMediaTransport:
    """Small authenticated REST transport matching the published Vertex media APIs."""

    def __init__(self, *, project: str, location: str = "us-central1") -> None:
        self.project = project
        self.location = location

    def _headers(self) -> dict[str, str]:
        credentials, _ = google.auth.default(
            scopes=("https://www.googleapis.com/auth/cloud-platform",)
        )
        credentials.refresh(Request())
        return {"Authorization": f"Bearer {credentials.token}"}

    def _post(self, url: str, body: dict[str, Any], *, timeout: float) -> dict[str, Any]:
        try:
            response = httpx.post(url, json=body, headers=self._headers(), timeout=timeout)
        except httpx.HTTPError as exc:
            raise MediaProviderError(f"media transport failed: {exc}") from exc
        if response.status_code >= 300:
            permanent = response.status_code < 500 and response.status_code != 429
            raise MediaProviderError(
                f"media provider returned HTTP {response.status_code}", permanent=permanent,
            )
        try:
            data = response.json()
        except ValueError as exc:
            raise MediaProtocolError("media provider returned malformed JSON") from exc
        if not isinstance(data, dict):
            raise MediaProtocolError("media provider returned a non-object response")
        return data

    def start_veo(self, **kwargs: Any) -> dict[str, Any]:
        model = kwargs["model"]
        url = (
            f"https://{self.location}-aiplatform.googleapis.com/v1/projects/{self.project}"
            f"/locations/{self.location}/publishers/google/models/{model}:predictLongRunning"
        )
        return self._post(url, {
            "instances": [{"prompt": kwargs["prompt"]}],
            "parameters": {
                "durationSeconds": kwargs["duration_sec"],
                "aspectRatio": kwargs["aspect_ratio"],
                "resolution": "720p",
                "sampleCount": 1,
                "generateAudio": False,
                "personGeneration": "disallow",
            },
        }, timeout=60)

    def poll_veo(self, operation_name: str) -> dict[str, Any]:
        url = (
            f"https://{self.location}-aiplatform.googleapis.com/v1/projects/{self.project}"
            f"/locations/{self.location}/publishers/google/models/{VEO_MODEL}:fetchPredictOperation"
        )
        return self._post(url, {"operationName": operation_name}, timeout=60)

    def generate_lyria(self, **kwargs: Any) -> dict[str, Any]:
        url = (
            "https://aiplatform.googleapis.com/v1beta1/projects/"
            f"{self.project}/locations/global/interactions"
        )
        return self._post(url, {
            "model": kwargs["model"],
            "input": [{"type": "text", "text": kwargs["prompt"]}],
        }, timeout=180)


def _decode(value: Any, *, media: str) -> bytes:
    if not isinstance(value, str) or not value:
        raise MediaProtocolError(f"{media} response is missing encoded data")
    try:
        data = base64.b64decode(value, validate=True)
    except ValueError as exc:
        raise MediaProtocolError(f"{media} response contains invalid encoded data") from exc
    if not data:
        raise MediaProtocolError(f"{media} response decoded to empty data")
    return data


class VeoGenerator:
    def __init__(self, *, transport: MediaTransport) -> None:
        self.transport = transport

    def generate(
        self,
        *,
        prompt: str,
        duration_sec: int,
        aspect_ratio: str,
        existing_operation: str | None,
        persist_operation: Callable[[str], None],
    ) -> GeneratedMedia:
        if duration_sec != 4 or aspect_ratio not in {"16:9", "9:16"}:
            raise MediaProtocolError("Veo action must request 4 seconds and a supported aspect ratio")
        with tracer().start_as_current_span("harmonia.media.generate") as span:
            span.set_attributes(safe_attributes({
                "provider": "vertex_ai", "model": VEO_MODEL,
                "media.kind": "video", "media.duration_sec": duration_sec,
            }))
            operation_name = existing_operation
            if operation_name is None:
                started = self.transport.start_veo(
                    model=VEO_MODEL,
                    prompt=prompt,
                    duration_sec=duration_sec,
                    aspect_ratio=aspect_ratio,
                )
                operation_name = started.get("name")
                if not isinstance(operation_name, str) or not operation_name:
                    raise MediaProtocolError("Veo did not return an operation name")
                persist_operation(operation_name)
            polled = self.transport.poll_veo(operation_name)
            if polled.get("done") is not True:
                raise MediaOperationPending(operation_name)
            if polled.get("error"):
                raise MediaProtocolError("Veo operation completed with an error")
            videos = (polled.get("response") or {}).get("videos") or []
            if not videos:
                raise MediaProtocolError("Veo completed without a video output")
            video = videos[0]
            data = _decode(
                video.get("bytesBase64Encoded") or video.get("bytes_base64_encoded"),
                media="video",
            )
            return GeneratedMedia(
                data=data,
                mime=str(video.get("mimeType") or video.get("mime_type") or "video/mp4"),
                model=VEO_MODEL,
                provider_id=operation_name,
                duration_sec=duration_sec,
                estimated_cost_usd="0.080000",
            )


class LyriaGenerator:
    def __init__(self, *, transport: MediaTransport) -> None:
        self.transport = transport

    def generate(self, *, prompt: str, duration_sec: int) -> GeneratedMedia:
        if duration_sec != 30:
            raise MediaProtocolError("Lyria clip action must request exactly 30 seconds")
        with tracer().start_as_current_span("harmonia.media.generate") as span:
            span.set_attributes(safe_attributes({
                "provider": "vertex_ai", "model": LYRIA_MODEL,
                "media.kind": "audio", "media.duration_sec": duration_sec,
            }))
            response = self.transport.generate_lyria(model=LYRIA_MODEL, prompt=prompt)
            if response.get("status") != "completed":
                raise MediaProtocolError("Lyria interaction did not complete")
            output = next(
                (item for item in response.get("outputs", []) if item.get("type") == "audio"),
                None,
            )
            if output is None:
                raise MediaProtocolError("Lyria completed without an audio output")
            provider_id = response.get("id") or response.get("object")
            if not isinstance(provider_id, str) or not provider_id:
                raise MediaProtocolError("Lyria response is missing an interaction id")
            return GeneratedMedia(
                data=_decode(output.get("data"), media="audio"),
                mime=str(output.get("mime_type") or "audio/mpeg"),
                model=LYRIA_MODEL,
                provider_id=provider_id,
                duration_sec=duration_sec,
                estimated_cost_usd="0.040000",
            )

