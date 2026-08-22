from __future__ import annotations

import asyncio

import pytest
from google.adk.models.llm_request import LlmRequest
from google.genai import types

from harmonia_agent.gemma_model import GemmaEndpointError, VertexGemmaModel


def _request_with_text(text: str) -> LlmRequest:
    return LlmRequest(
        contents=[types.Content(role="user", parts=[types.Part(text=text)])],
        config=types.GenerateContentConfig(
            system_instruction="Return JSON only.",
            response_schema={
                "type": "object",
                "properties": {"drafts": {"type": "array", "items": {"type": "object"}}},
            },
        ),
    )


async def _collect(model: VertexGemmaModel, request: LlmRequest):
    return [response async for response in model.generate_content_async(request)]


def test_gemma_adapter_converts_adk_request_and_yields_text():
    calls: list[tuple] = []

    async def predict(endpoint, instances, parameters):
        calls.append((endpoint, instances, parameters))
        return {"predictions": [{"content": '{"drafts":[]}'}]}

    model = VertexGemmaModel(
        model="gemma-3-12b-it",
        endpoint="projects/p/locations/us-central1/endpoints/1",
        predict=predict,
    )

    responses = asyncio.run(_collect(model, _request_with_text("write")))

    assert responses[0].content.parts[0].text == '{"drafts":[]}'
    assert calls[0][0].endswith("/endpoints/1")
    prompt = calls[0][1][0]["prompt"]
    assert "Return JSON only" in prompt
    assert "write" in prompt
    assert '"drafts"' in prompt


def test_gemma_adapter_does_not_fallback_on_transport_failure():
    async def fail(*_args):
        raise TimeoutError("endpoint timeout")

    model = VertexGemmaModel(
        model="gemma-3-12b-it",
        endpoint="projects/p/locations/us-central1/endpoints/1",
        predict=fail,
    )

    with pytest.raises(GemmaEndpointError, match="endpoint timeout"):
        asyncio.run(_collect(model, _request_with_text("write")))


@pytest.mark.parametrize("payload", [
    {},
    {"predictions": []},
    {"predictions": [{"unexpected": "shape"}]},
])
def test_gemma_adapter_rejects_malformed_prediction(payload):
    async def predict(*_args):
        return payload

    model = VertexGemmaModel(
        model="gemma-3-12b-it",
        endpoint="projects/p/locations/us-central1/endpoints/1",
        predict=predict,
    )

    with pytest.raises(GemmaEndpointError, match="prediction"):
        asyncio.run(_collect(model, _request_with_text("write")))
