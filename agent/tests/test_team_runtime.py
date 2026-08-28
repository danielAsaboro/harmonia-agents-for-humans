"""Managed Agent Engine runtime contracts."""

from __future__ import annotations

import asyncio

import pytest
from google.adk.agents import Agent
from google.adk.models._capabilities import LlmCapabilities
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from harmonia_agent.team_runtime import (
    AgentEngineProviderError,
    AgentEngineProtocolError,
    AgentEngineTeamRuntime,
    LocalAdkTeamRuntime,
    _request_scoped_tools,
    _specialist_prompt_payload,
)
from harmonia_agent.agent_models import SourceAnalysis
from harmonia_agent.agent_engine_app import build_agent_engine_app
from harmonia_agent.agent_engine_deploy import build_deployment_config
from harmonia_agent.coordinator import HarmoniaCoordinator


class _RemoteAgent:
    def __init__(self) -> None:
        self.created: list[dict] = []
        self.queries: list[dict] = []
        self.deleted: list[dict] = []
        self.sessions: dict[str, dict] = {}

    async def async_get_session(self, **kwargs):
        return self.sessions.get(kwargs["session_id"])

    async def async_create_session(self, **kwargs):
        self.created.append(kwargs)
        session = {"id": kwargs["session_id"], "state": dict(kwargs["state"])}
        self.sessions[kwargs["session_id"]] = session
        return session

    async def async_stream_query(self, **kwargs):
        self.queries.append(kwargs)
        yield {
            "author": "nimi_analyst",
            "actions": {"state_delta": {
                "source_analysis": {
                    "summary": "Managed analysis",
                    "moments": [],
                    "angles": [],
                },
            }},
        }

    async def async_delete_session(self, **kwargs):
        self.deleted.append(kwargs)


def test_local_specialist_prompt_excludes_runtime_only_projection() -> None:
    payload = {
        "title": "Demo",
        "transcript": "proof",
        "_durable_context_projection": {"manifestDigest": "a" * 64},
    }
    assert _specialist_prompt_payload(payload) == {
        "title": "Demo",
        "transcript": "proof",
    }


def test_nimi_research_tool_is_absent_without_a_typed_research_request() -> None:
    tools = [object()]
    assert _request_scoped_tools("nimi_analyst", {"researchRequest": None}, tools) == []
    assert _request_scoped_tools(
        "nimi_analyst", {"researchRequest": {"mode": "public_web"}}, tools,
    ) == tools


class _InvalidStructuredOutputModel(BaseLlm):
    @property
    def capabilities(self) -> LlmCapabilities:
        return LlmCapabilities(output_schema_and_tools=True)

    async def generate_content_async(self, llm_request, stream=False):
        yield LlmResponse(content=types.Content(role="model", parts=[types.Part(
            text='{"groundedMoments":[],"gapsAndCritique":[]}',
        )]))


class _ValidStructuredOutputModel(BaseLlm):
    @property
    def capabilities(self) -> LlmCapabilities:
        return LlmCapabilities(output_schema_and_tools=True)

    async def generate_content_async(self, llm_request, stream=False):
        yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text=(
            '{"sourceDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",'
            '"summary":"Grounded analysis","moments":[],"angles":[{"id":"angle-1",'
            '"angleType":"source_insight","evidenceKind":"source","title":"Source proof",'
            '"rationale":"The supplied source contains a claim.","evidenceRefs":["segment-1"],'
            '"assumptions":[],"confidence":"medium"}],"assumptions":[],"confidence":"medium"}'
        ))]))


def _local_runtime(model: BaseLlm) -> LocalAdkTeamRuntime:
    specialist = Agent(
        name="nimi_analyst", model=model, instruction="Return SourceAnalysis JSON.",
        output_schema=SourceAnalysis, output_key="source_analysis", mode="single_turn",
    )
    root = HarmoniaCoordinator(
        name="harmonia_coordinator",
        sub_agents=[specialist],
    )
    return LocalAdkTeamRuntime(root)


def test_local_runtime_runs_valid_single_turn_specialist_under_a_workflow_root() -> None:
    state = asyncio.run(_local_runtime(_ValidStructuredOutputModel(model="valid-output")).invoke(
        specialist="nimi_analyst",
        payload={"title": "Demo"},
        user_id="workspace:user",
        session_key="job:understand:0",
    ))

    assert state["source_analysis"]["summary"] == "Grounded analysis"


def test_local_runtime_forwards_rejected_output_to_harmonia_contract_repair() -> None:
    state = asyncio.run(_local_runtime(_InvalidStructuredOutputModel(model="invalid-output")).invoke(
        specialist="nimi_analyst",
        payload={"title": "Demo"},
        user_id="workspace:user",
        session_key="job:understand:0",
    ))

    assert state["source_analysis"] == {"groundedMoments": [], "gapsAndCritique": []}


class _AgentEngines:
    def __init__(self, remote: _RemoteAgent) -> None:
        self.remote = remote
        self.get_calls: list[str] = []

    def get(self, *, name: str):
        self.get_calls.append(name)
        return self.remote


class _Client:
    def __init__(self, remote: _RemoteAgent) -> None:
        self.agent_engines = _AgentEngines(remote)


def test_runtime_module_exposes_managed_runtime_only():
    import harmonia_agent.team_runtime as runtime

    assert not hasattr(runtime, "runtime_mode")
    assert not hasattr(runtime, "RuntimeMode")


def test_agent_engine_runtime_seeds_a_deterministic_persistent_session_and_collects_deltas():
    remote = _RemoteAgent()
    runtime = AgentEngineTeamRuntime(
        resource_name="projects/p/locations/us-central1/reasoningEngines/42",
        client=_Client(remote),
    )

    state = asyncio.run(runtime.invoke(
        specialist="nimi_analyst",
        payload={"title": "Demo", "transcript": "proof"},
        user_id="job-123",
        session_key="job-123:understand:0:nimi_analyst",
    ))

    assert state["source_analysis"]["summary"] == "Managed analysis"
    assert remote.created == [{
        "user_id": "job-123",
        "session_id": remote.created[0]["session_id"],
        "state": {
            "title": "Demo",
            "transcript": "proof",
            "requested_specialist": "nimi_analyst",
        },
    }]
    assert remote.created[0]["session_id"].startswith("harmonia-")
    assert remote.queries[0]["session_id"] == remote.created[0]["session_id"]
    assert remote.deleted == []


def test_runtime_resumes_the_same_managed_session_after_process_restart():
    remote = _RemoteAgent()
    kwargs = dict(
        specialist="nimi_analyst", payload={"title": "Demo", "transcript": "proof"},
        user_id="job-123", session_key="job-123:understand:0:nimi_analyst",
    )
    first = AgentEngineTeamRuntime(
        resource_name="projects/p/locations/us-central1/reasoningEngines/42", client=_Client(remote),
    )
    asyncio.run(first.invoke(**kwargs))
    restarted = AgentEngineTeamRuntime(
        resource_name="projects/p/locations/us-central1/reasoningEngines/42", client=_Client(remote),
    )
    asyncio.run(restarted.invoke(**kwargs))

    assert len(remote.created) == 1
    assert len(remote.queries) == 2
    assert remote.queries[0]["session_id"] == remote.queries[1]["session_id"]


def test_runtime_explicitly_directs_agents_to_the_pinned_projection_when_present():
    remote = _RemoteAgent()
    runtime = AgentEngineTeamRuntime(
        resource_name="projects/p/locations/us-central1/reasoningEngines/42",
        client=_Client(remote),
    )
    asyncio.run(runtime.invoke(
        specialist="nimi_analyst",
        payload={
            "title": "Demo",
            "_durable_context_projection": {
                "manifestDigest": "a" * 64,
                "rendered": "# AUTHORITY — PINNED, NON-COMPACTABLE",
            },
        },
        user_id="job-123",
        session_key="op-1:projection-a",
    ))
    assert "_durable_context_projection" in remote.queries[0]["message"]
    assert "pinned authority" in remote.queries[0]["message"]


def test_runtime_preserves_native_google_search_grounding_metadata():
    class GroundedRemote(_RemoteAgent):
        async def async_stream_query(self, **kwargs):
            yield {
                "author": "noni_copywriter",
                "groundingMetadata": {
                    "webSearchQueries": ["Google ADK grounding"],
                    "groundingChunks": [{
                        "web": {"title": "Google Search Grounding", "uri": "https://adk.dev/grounding/google_search_grounding/"},
                    }],
                    "groundingSupports": [{
                        "segment": {"text": "Ground responses with Google Search."},
                        "groundingChunkIndices": [0],
                    }],
                },
                "actions": {"stateDelta": {"copywriter_draft": {"id": "draft-1"}}},
            }

    runtime = AgentEngineTeamRuntime(
        resource_name="projects/p/locations/us-central1/reasoningEngines/42",
        client=_Client(GroundedRemote()),
    )

    state = asyncio.run(runtime.invoke(
        specialist="noni_copywriter", payload={"briefId": "brief-1"},
        user_id="job-123", session_key="op-1",
    ))

    assert state["_adk_grounding_metadata"]["webSearchQueries"] == ["Google ADK grounding"]
    assert state["_adk_grounding_metadata"]["groundingChunks"][0]["web"]["uri"] == (
        "https://adk.dev/grounding/google_search_grounding/"
    )


def test_runtime_never_mutates_the_caller_payload_or_retrieved_session_state():
    class ReadOnlySessionRemote(_RemoteAgent):
        async def async_create_session(self, **kwargs):
            self.created.append(kwargs)
            return {"id": kwargs["session_id"], "state": _MutationTrap()}

    class _MutationTrap(dict):
        def __setitem__(self, key, value):
            raise AssertionError("retrieved session state must not be mutated")

        def update(self, *args, **kwargs):
            raise AssertionError("retrieved session state must not be mutated")

    payload = {"title": "Demo", "nested": {"evidence": "bounded"}}
    original = {"title": "Demo", "nested": {"evidence": "bounded"}}
    runtime = AgentEngineTeamRuntime(
        resource_name="projects/p/locations/us-central1/reasoningEngines/42",
        client=_Client(ReadOnlySessionRemote()),
    )
    asyncio.run(runtime.invoke(
        specialist="nimi_analyst", payload=payload, user_id="job-123", session_key="op-1",
    ))
    assert payload == original


def test_agent_engine_runtime_rejects_events_without_state_and_does_not_fallback():
    class EmptyRemote(_RemoteAgent):
        async def async_stream_query(self, **kwargs):
            yield {"author": "harmonia_coordinator", "content": {"parts": [{"text": "done"}]}}

    runtime = AgentEngineTeamRuntime(
        resource_name="projects/p/locations/us-central1/reasoningEngines/42",
        client=_Client(EmptyRemote()),
    )

    with pytest.raises(AgentEngineProtocolError, match="state delta"):
        asyncio.run(runtime.invoke(
            specialist="nimi_analyst",
            payload={"title": "Demo", "transcript": "proof"},
            user_id="job-123",
            session_key="op-1",
        ))


def test_agent_engine_deployment_wraps_the_existing_root_hierarchy():
    class FakeAdkApp:
        def __init__(self, *, agent):
            self.agent = agent

    app = build_agent_engine_app(adk_app_type=FakeAdkApp, model="gemini-test")

    assert app.agent.name == "harmonia_coordinator"
    assert [agent.name for agent in app.agent.sub_agents] == [
        "harmonia_intent_router",
        "ryan_strategist", "nimi_analyst", "temi_editorial_planner",
        "noni_copywriter", "dara_editor", "noni_artifact_producer",
        "dara_artifact_editor", "maya_presenter", "nova_liaison",
    ]


def test_agent_engine_deployment_config_is_narrow_and_reproducible():
    config = build_deployment_config(
        staging_bucket="gs://harmonia-agent-staging",
        service_account="harmonia-agent@p.iam.gserviceaccount.com",
        environment={
            "COORDINATOR_MODEL_ID": "gemini-3.5-flash-lite",
            "PRESENTER_MODEL_ID": "gemini-3.5-flash",
            "COPYWRITER_MODEL_ID": "gemini-3.5-flash",
            "WEB_INTERNAL_URL": "https://harmonia-web.example",
            "GOOGLE_CSE_ID": "search-engine-1",
            "GOOGLE_CLOUD_PROJECT": "must-be-runtime-injected",
            "GOOGLE_CLOUD_LOCATION": "must-be-runtime-injected",
            "INTERNAL_API_TOKEN": "must-not-be-forwarded",
        },
    )
    assert config["staging_bucket"] == "gs://harmonia-agent-staging"
    assert config["service_account"] == "harmonia-agent@p.iam.gserviceaccount.com"
    assert "google-cloud-aiplatform[agent_engines,adk]>=1.153,<2" in config["requirements"]
    assert "google-adk>=2.7,<3" in config["requirements"]
    assert "opentelemetry-exporter-otlp-proto-grpc>=1.42,<2" in config["requirements"]
    assert "google-cloud-firestore>=2.19" in config["requirements"]
    assert config["extra_packages"] == ["harmonia_agent"]
    assert config["env_vars"] == {
        "COORDINATOR_MODEL_ID": "gemini-3.5-flash-lite",
        "PRESENTER_MODEL_ID": "gemini-3.5-flash",
        "COPYWRITER_MODEL_ID": "gemini-3.5-flash",
        "WEB_INTERNAL_URL": "https://harmonia-web.example",
        "INTERNAL_API_TOKEN": {"secret": "internal-api-token", "version": "latest"},
    }
