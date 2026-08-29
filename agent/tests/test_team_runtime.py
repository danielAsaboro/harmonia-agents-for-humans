"""Managed Agent Engine runtime contracts."""

from __future__ import annotations

import asyncio

import pytest

from harmonia_agent.team_runtime import (
    AgentEngineProtocolError,
    AgentEngineTeamRuntime,
)
from harmonia_agent.agent_engine_app import build_agent_engine_app
from harmonia_agent.agent_engine_deploy import build_deployment_config
from harmonia_agent.agents import _resolve_role_models


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


def test_runtime_configures_managed_client_for_long_role_streams(monkeypatch):
    """Catches the SDK's default request timeout cutting off Ryan mid-stream."""

    import vertexai

    captured = {}

    class AgentEngines:
        def get(self, *, name):
            return {"name": name}

    def client(**kwargs):
        captured.update(kwargs)
        return type("Client", (), {"agent_engines": AgentEngines()})()

    monkeypatch.setattr(vertexai, "Client", client)
    runtime = AgentEngineTeamRuntime(
        resource_name="projects/p/locations/us-central1/reasoningEngines/42",
    )

    runtime._remote()

    assert captured["http_options"] == {"timeout": 300_000}


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
    assert "Call transfer_to_agent for nimi_analyst now" in remote.queries[0]["message"]
    assert '<specialist_payload>{"requested_specialist":"nimi_analyst","title":"Demo","transcript":"proof"}</specialist_payload>' in remote.queries[0]["message"]
    assert len(remote.queries[0]["message"]) < 500
    assert remote.deleted == []


def test_runtime_creates_session_when_managed_sdk_raises_not_found():
    class SdkAccurateRemote(_RemoteAgent):
        async def async_get_session(self, **kwargs):
            session = self.sessions.get(kwargs["session_id"])
            if session is None:
                raise RuntimeError("Session not found")
            return session

    remote = SdkAccurateRemote()
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
    assert len(remote.created) == 1


def test_runtime_creates_session_when_managed_sdk_wraps_not_found_in_client_error():
    class ClientError(Exception):
        pass

    class RealErrorShapeRemote(_RemoteAgent):
        async def async_get_session(self, **kwargs):
            session = self.sessions.get(kwargs["session_id"])
            if session is None:
                raise ClientError(
                    "400 INVALID_ARGUMENT: Agent Engine Error: Session not found. "
                    "Please create it using .create_session()"
                )
            return session

    remote = RealErrorShapeRemote()
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
    assert len(remote.created) == 1


def test_runtime_uses_sync_sdk_methods_when_async_transport_connector_is_closed():
    class SyncCapableRemote(_RemoteAgent):
        async def async_get_session(self, **kwargs):
            raise AssertionError("closed aiohttp connector")

        def get_session(self, **kwargs):
            return self.sessions.get(kwargs["session_id"])

        def create_session(self, **kwargs):
            self.created.append(kwargs)
            session = {"id": kwargs["session_id"], "state": dict(kwargs["state"])}
            self.sessions[kwargs["session_id"]] = session
            return session

        def stream_query(self, **kwargs):
            self.queries.append(kwargs)
            yield {
                "author": "nimi_analyst",
                "actions": {"state_delta": {
                    "source_analysis": {"summary": "Managed analysis", "moments": [], "angles": []},
                }},
            }

    remote = SyncCapableRemote()
    runtime = AgentEngineTeamRuntime(
        resource_name="projects/p/locations/us-central1/reasoningEngines/42",
        client=_Client(remote),
    )

    state = asyncio.run(runtime.invoke(
        specialist="nimi_analyst", payload={"title": "Demo"},
        user_id="job-123", session_key="op-1",
    ))

    assert state["source_analysis"]["summary"] == "Managed analysis"
    assert len(remote.created) == 1


def test_sync_runtime_creates_session_before_opaque_managed_not_found_lookup():
    """Catches a fresh Agent Engine rejecting get_session without exposing its cause."""

    class OpaqueLookupRemote(_RemoteAgent):
        def get_session(self, **kwargs):
            raise RuntimeError("400 Invalid Argument")

        def create_session(self, **kwargs):
            self.created.append(kwargs)
            session = {"id": kwargs["session_id"], "state": dict(kwargs["state"])}
            self.sessions[kwargs["session_id"]] = session
            return session

        def stream_query(self, **kwargs):
            yield {"actions": {"state_delta": {
                "source_analysis": {"summary": "Managed analysis", "moments": [], "angles": []},
            }}}

    remote = OpaqueLookupRemote()
    runtime = AgentEngineTeamRuntime(
        resource_name="projects/p/locations/us-central1/reasoningEngines/42",
        client=_Client(remote),
    )

    state = asyncio.run(runtime.invoke(
        specialist="nimi_analyst", payload={"title": "Demo"},
        user_id="job-123", session_key="op-1",
    ))

    assert state["source_analysis"]["summary"] == "Managed analysis"
    assert len(remote.created) == 1


def test_sync_runtime_recovers_persisted_state_when_stream_terminates_after_handoff():
    class InterruptedRemote(_RemoteAgent):
        def create_session(self, **kwargs):
            self.created.append(kwargs)
            session = {"id": kwargs["session_id"], "state": dict(kwargs["state"])}
            self.sessions[kwargs["session_id"]] = session
            return session

        def get_session(self, **kwargs):
            return self.sessions[kwargs["session_id"]]

        def stream_query(self, **kwargs):
            self.sessions[kwargs["session_id"]]["state"].update({
                "source_analysis": {"summary": "Persisted managed analysis", "moments": [], "angles": []},
            })
            raise RuntimeError("managed SSE stream terminated")
            yield  # pragma: no cover

    runtime = AgentEngineTeamRuntime(
        resource_name="projects/p/locations/us-central1/reasoningEngines/42",
        client=_Client(InterruptedRemote()),
    )

    state = asyncio.run(runtime.invoke(
        specialist="nimi_analyst", payload={"title": "Demo"},
        user_id="job-123", session_key="op-1",
    ))

    assert state["source_analysis"]["summary"] == "Persisted managed analysis"


def test_sync_runtime_does_not_mask_stream_failure_without_persisted_output_state():
    class InterruptedRemote(_RemoteAgent):
        def create_session(self, **kwargs):
            session = {"id": kwargs["session_id"], "state": dict(kwargs["state"])}
            self.sessions[kwargs["session_id"]] = session
            return session

        def get_session(self, **kwargs):
            return self.sessions[kwargs["session_id"]]

        def stream_query(self, **kwargs):
            raise RuntimeError("managed SSE stream terminated")
            yield  # pragma: no cover

    runtime = AgentEngineTeamRuntime(
        resource_name="projects/p/locations/us-central1/reasoningEngines/42",
        client=_Client(InterruptedRemote()),
    )

    with pytest.raises(Exception, match="managed SSE stream terminated"):
        asyncio.run(runtime.invoke(
            specialist="nimi_analyst", payload={"title": "Demo"},
            user_id="job-123", session_key="op-1",
        ))


def test_async_runtime_recovers_persisted_state_when_stream_terminates_after_handoff():
    class AsyncInterruptedRemote(_RemoteAgent):
        async def async_stream_query(self, **kwargs):
            self.sessions[kwargs["session_id"]]["state"].update({
                "source_analysis": {"summary": "Persisted async analysis", "moments": [], "angles": []},
            })
            raise RuntimeError("managed async SSE stream terminated")
            yield  # pragma: no cover

    runtime = AgentEngineTeamRuntime(
        resource_name="projects/p/locations/us-central1/reasoningEngines/42",
        client=_Client(AsyncInterruptedRemote()),
    )

    state = asyncio.run(runtime.invoke(
        specialist="nimi_analyst", payload={"title": "Demo"},
        user_id="job-123", session_key="op-1",
    ))

    assert state["source_analysis"]["summary"] == "Persisted async analysis"


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
    assert "# AUTHORITY" not in remote.queries[0]["message"]
    assert "_durable_context_projection" not in remote.queries[0]["message"]
    assert "Read _durable_context_projection" not in remote.queries[0]["message"]


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
            "GEMINI_VERTEX_LOCATION": "global",
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
        "GEMINI_VERTEX_LOCATION": "global",
        "INTERNAL_API_TOKEN": {"secret": "internal-api-token", "version": "latest"},
        "GEMINI_API_KEY": {"secret": "gemini-api-key", "version": "latest"},
    }


def test_role_models_use_explicit_global_vertex_location(monkeypatch):
    monkeypatch.setenv("GEMINI_VERTEX_LOCATION", "global")
    monkeypatch.setenv("COORDINATOR_MODEL_ID", "gemini-3.5-flash-lite")

    models = _resolve_role_models()

    assert models.coordinator.model == "gemini-3.5-flash-lite"
    assert models.coordinator.client_kwargs == {"vertexai": True, "location": "global"}
