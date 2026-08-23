"""Managed Agent Engine runtime contracts."""

from __future__ import annotations

import asyncio

import pytest

from harmonia_agent.team_runtime import (
    AgentEngineProtocolError,
    AgentEngineTeamRuntime,
    runtime_mode,
)
from harmonia_agent.agent_engine_app import build_agent_engine_app


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


def test_runtime_mode_is_explicit_and_rejects_unknown_values():
    assert runtime_mode("local") == "local"
    assert runtime_mode("agent_engine") == "agent_engine"
    with pytest.raises(ValueError, match="TEAM_RUNTIME"):
        runtime_mode("automatic")


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
        "ryan_strategist", "sophia_analyst",
    ]
