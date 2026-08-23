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


class _RemoteAgent:
    def __init__(self) -> None:
        self.created: list[dict] = []
        self.queries: list[dict] = []
        self.deleted: list[dict] = []

    async def async_create_session(self, **kwargs):
        self.created.append(kwargs)
        return {"id": "managed-session-1"}

    async def async_stream_query(self, **kwargs):
        self.queries.append(kwargs)
        yield {
            "author": "sophia_analyst",
            "actions": {"state_delta": {
                "analysis_result": {
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


def test_agent_engine_runtime_seeds_state_collects_deltas_and_discards_session():
    remote = _RemoteAgent()
    runtime = AgentEngineTeamRuntime(
        resource_name="projects/p/locations/us-central1/reasoningEngines/42",
        client=_Client(remote),
    )

    state = asyncio.run(runtime.invoke(
        specialist="sophia_analyst",
        payload={"title": "Demo", "transcript": "proof"},
        user_id="job-123",
    ))

    assert state["analysis_result"]["summary"] == "Managed analysis"
    assert remote.created == [{
        "user_id": "job-123",
        "state": {
            "title": "Demo",
            "transcript": "proof",
            "requested_specialist": "sophia_analyst",
        },
    }]
    assert remote.queries[0]["session_id"] == "managed-session-1"
    assert remote.deleted == [{"user_id": "job-123", "session_id": "managed-session-1"}]


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
            specialist="sophia_analyst",
            payload={"title": "Demo", "transcript": "proof"},
            user_id="job-123",
        ))


def test_agent_engine_deployment_wraps_the_existing_root_hierarchy():
    class FakeAdkApp:
        def __init__(self, *, agent):
            self.agent = agent

    app = build_agent_engine_app(adk_app_type=FakeAdkApp, model="gemini-test")

    assert app.agent.name == "harmonia_coordinator"
    assert [agent.name for agent in app.agent.sub_agents] == [
        "ryan_strategist", "sophia_analyst", "maya_presenter",
    ]


def test_agent_engine_deployment_config_is_narrow_and_reproducible():
    config = build_deployment_config(
        staging_bucket="gs://harmonia-agent-staging",
        service_account="harmonia-agent@p.iam.gserviceaccount.com",
        environment={
            "COORDINATOR_MODEL_ID": "gemini-3.5-flash-lite",
            "GEMMA_VERTEX_ENDPOINT": "projects/p/locations/us-central1/endpoints/1",
            "INTERNAL_API_TOKEN": "must-not-be-forwarded",
        },
    )
    assert config["staging_bucket"] == "gs://harmonia-agent-staging"
    assert config["service_account"] == "harmonia-agent@p.iam.gserviceaccount.com"
    assert config["requirements"] == ["google-cloud-aiplatform[agent_engines,adk]>=1.153,<2"]
    assert config["env_vars"] == {
        "COORDINATOR_MODEL_ID": "gemini-3.5-flash-lite",
        "GEMMA_VERTEX_ENDPOINT": "projects/p/locations/us-central1/endpoints/1",
    }
