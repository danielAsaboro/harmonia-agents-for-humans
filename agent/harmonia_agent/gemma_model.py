"""Google ADK adapter for a Gemma model deployed to a Vertex endpoint."""

from __future__ import annotations

import asyncio
import json
from time import monotonic
from collections.abc import Awaitable, Callable
from typing import Any

import google.auth
import google.auth.transport.requests
import httpx
from google.adk.models._capabilities import LlmCapabilities
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from pydantic import BaseModel, Field

PredictTransport = Callable[
    [str, list[dict[str, object]], dict[str, object]],
    Awaitable[dict[str, Any]],
]


class GemmaEndpointError(RuntimeError):
    """The configured Vertex Gemma endpoint failed or violated its protocol."""


class GemmaProtocolError(GemmaEndpointError):
    """The endpoint returned an unsupported or contract-invalid payload."""


async def _vertex_predict(
    endpoint: str,
    instances: list[dict[str, object]],
    parameters: dict[str, object],
) -> dict[str, Any]:
    credentials, _ = google.auth.default(
        scopes=("https://www.googleapis.com/auth/cloud-platform",),
    )
    request = google.auth.transport.requests.Request()
    await asyncio.to_thread(credentials.refresh, request)
    location = endpoint.split("/locations/", 1)[1].split("/", 1)[0]
    url = f"https://{location}-aiplatform.googleapis.com/v1/{endpoint}:predict"
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(
            url,
            headers={"Authorization": f"Bearer {credentials.token}"},
            json={"instances": instances, "parameters": parameters},
        )
    response.raise_for_status()
    return response.json()


def _content_text(content: types.Content) -> str:
    chunks: list[str] = []
    for part in content.parts or []:
        if part.text is not None:
            chunks.append(part.text)
        elif part.function_response is not None:
            chunks.append(json.dumps(part.function_response.model_dump(mode="json")))
        elif part.function_call is not None:
            chunks.append(json.dumps(part.function_call.model_dump(mode="json")))
        else:
            raise GemmaProtocolError("Gemma endpoint received an unsupported non-text part")
    return "\n".join(chunks)


def _request_prompt(request: LlmRequest) -> str:
    chunks: list[str] = []
    system = request.config.system_instruction
    if isinstance(system, str):
        chunks.append(f"<system>\n{system}\n</system>")
    elif isinstance(system, types.Content):
        chunks.append(f"<system>\n{_content_text(system)}\n</system>")
    elif system:
        chunks.append(f"<system>\n{system}\n</system>")
    for content in request.contents:
        chunks.append(f"<{content.role or 'user'}>\n{_content_text(content)}\n</{content.role or 'user'}>")
    if request.config.response_schema is not None:
        schema = request.config.response_schema
        if isinstance(schema, type) and issubclass(schema, BaseModel):
            schema = schema.model_json_schema()
        elif hasattr(schema, "model_dump"):
            schema = schema.model_dump(mode="json", exclude_none=True)
        chunks.append(
            "<output_schema>\n"
            + json.dumps(schema, default=str, separators=(",", ":"))
            + "\n</output_schema>"
        )
    return "\n\n".join(chunks)


def _prediction_text(payload: dict[str, Any]) -> str:
    predictions = payload.get("predictions")
    if not isinstance(predictions, list) or not predictions:
        raise GemmaProtocolError("Gemma endpoint returned no prediction")
    prediction = predictions[0]
    if isinstance(prediction, str) and prediction:
        return prediction
    if isinstance(prediction, dict):
        for key in ("content", "generated_text"):
            value = prediction.get(key)
            if isinstance(value, str) and value:
                return value
    raise GemmaProtocolError("Gemma endpoint returned a malformed prediction")


class VertexGemmaModel(BaseLlm):
    endpoint: str
    predict: PredictTransport = Field(default=_vertex_predict, exclude=True)

    @property
    def capabilities(self) -> LlmCapabilities:
        return LlmCapabilities(output_schema_and_tools=False)

    async def generate_content_async(
        self,
        llm_request: LlmRequest,
        stream: bool = False,
    ):
        if stream:
            raise GemmaProtocolError("Gemma endpoint streaming is not enabled")
        started = monotonic()
        try:
            payload = await self.predict(
                self.endpoint,
                [{"prompt": _request_prompt(llm_request)}],
                {
                    "maxOutputTokens": llm_request.config.max_output_tokens or 2048,
                    "temperature": llm_request.config.temperature or 0.7,
                },
            )
        except GemmaEndpointError:
            raise
        except Exception as exc:  # noqa: BLE001 - normalize provider failures
            raise GemmaEndpointError(f"Gemma endpoint request failed: {exc}") from exc
        yield LlmResponse(
            content=types.Content(
                role="model",
                parts=[types.Part(text=_prediction_text(payload))],
            ),
            model_version=self.model,
            custom_metadata={"harmonia_endpoint_seconds": monotonic() - started},
        )
