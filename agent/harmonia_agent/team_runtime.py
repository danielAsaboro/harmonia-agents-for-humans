"""Execution boundary for managed Vertex AI Agent Engine teams."""

from __future__ import annotations

from collections.abc import AsyncIterator
from hashlib import sha256
from typing import Any, Protocol

from .telemetry import safe_attributes, tracer

class AgentEngineProtocolError(RuntimeError):
    """Managed runtime completed without a valid state handoff."""


class AgentEngineProviderError(RuntimeError):
    """Managed runtime transport or provider execution failed."""


class TeamRuntime(Protocol):
    async def invoke(
        self,
        *,
        specialist: str,
        payload: dict[str, Any],
        user_id: str,
        session_key: str,
    ) -> dict[str, Any]: ...


def _session_id(session: Any) -> str:
    value = session.get("id") if isinstance(session, dict) else getattr(session, "id", None)
    if not value and isinstance(session, dict):
        name = session.get("name")
        value = str(name).rsplit("/", 1)[-1] if name else None
    if not value:
        raise AgentEngineProtocolError("Agent Engine did not return a managed session id")
    return str(value)


def _state_delta(event: Any) -> dict[str, Any]:
    if not isinstance(event, dict):
        event = event.model_dump(mode="json") if hasattr(event, "model_dump") else {}
    actions = event.get("actions") or {}
    delta = actions.get("state_delta") or actions.get("stateDelta") or {}
    return dict(delta) if isinstance(delta, dict) else {}


class AgentEngineTeamRuntime:
    """Managed runtime adapter with deterministic, restart-resumable sessions."""

    def __init__(self, *, resource_name: str, client: Any | None = None) -> None:
        if not resource_name.startswith("projects/") or "/reasoningEngines/" not in resource_name:
            raise ValueError("AGENT_ENGINE_RESOURCE must be a full reasoning engine resource name")
        self.resource_name = resource_name
        self._client = client

    def _remote(self) -> Any:
        client = self._client
        if client is None:
            try:
                import vertexai
            except ImportError as exc:  # pragma: no cover - deployment dependency
                raise AgentEngineProviderError(
                    "google-cloud-aiplatform agent_engines support is not installed"
                ) from exc
            client = vertexai.Client()
        try:
            return client.agent_engines.get(name=self.resource_name)
        except Exception as exc:  # noqa: BLE001 - normalized at provider boundary
            raise AgentEngineProviderError(f"failed to resolve Agent Engine: {exc}") from exc

    async def invoke(
        self,
        *,
        specialist: str,
        payload: dict[str, Any],
        user_id: str,
        session_key: str,
    ) -> dict[str, Any]:
        remote = self._remote()
        seeded_state = dict(payload)
        seeded_state["requested_specialist"] = specialist
        session_id = f"harmonia-{sha256(f'{user_id}|{session_key}'.encode()).hexdigest()[:40]}"
        state: dict[str, Any] = {}
        with tracer().start_as_current_span("harmonia.agent_runtime.invoke") as span:
            span.set_attributes(safe_attributes({
                "runtime": "agent_engine",
                "agent": specialist,
                "resource": self.resource_name,
            }))
            try:
                session = await remote.async_get_session(user_id=user_id, session_id=session_id)
                if session is None:
                    try:
                        session = await remote.async_create_session(
                            user_id=user_id, session_id=session_id, state=seeded_state,
                        )
                    except Exception:  # a concurrent creator may have won
                        session = await remote.async_get_session(
                            user_id=user_id, session_id=session_id,
                        )
                        if session is None:
                            raise
                if _session_id(session) != session_id:
                    raise AgentEngineProtocolError("Agent Engine returned the wrong managed session")
                prompt = (
                    f"Delegate this request to {specialist} exactly once. "
                    "Use the typed payload already present in managed session state."
                )
                events: AsyncIterator[Any] = remote.async_stream_query(
                    user_id=user_id,
                    session_id=session_id,
                    message=prompt,
                )
                async for event in events:
                    state.update(_state_delta(event))
            except AgentEngineProtocolError:
                raise
            except Exception as exc:  # noqa: BLE001 - normalized at provider boundary
                raise AgentEngineProviderError(f"Agent Engine invocation failed: {exc}") from exc
            if not state:
                raise AgentEngineProtocolError("Agent Engine returned no state delta")
            span.set_attribute("state.key_count", len(state))
            return state
