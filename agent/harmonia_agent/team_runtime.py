"""Execution boundary for managed Vertex AI Agent Engine teams."""

from __future__ import annotations

import asyncio
import json
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


def _session_state(session: Any) -> dict[str, Any]:
    value = session.get("state") if isinstance(session, dict) else getattr(session, "state", None)
    return dict(value) if isinstance(value, dict) else {}


def _persisted_delta(session: Any, seeded_state: dict[str, Any]) -> dict[str, Any]:
    state = _session_state(session)
    return {
        key: value for key, value in state.items()
        if key not in seeded_state or value != seeded_state[key]
    }


def _is_missing_session_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return "session not found" in message and (
        isinstance(exc, RuntimeError) or "create_session" in message
    )


def _state_delta(event: Any) -> dict[str, Any]:
    if not isinstance(event, dict):
        event = event.model_dump(mode="json") if hasattr(event, "model_dump") else {}
    actions = event.get("actions") or {}
    delta = actions.get("state_delta") or actions.get("stateDelta") or {}
    return dict(delta) if isinstance(delta, dict) else {}


def _grounding_metadata(event: Any) -> dict[str, Any] | None:
    if not isinstance(event, dict):
        event = event.model_dump(mode="json", by_alias=True) if hasattr(event, "model_dump") else {}
    metadata = event.get("grounding_metadata") or event.get("groundingMetadata")
    if hasattr(metadata, "model_dump"):
        metadata = metadata.model_dump(mode="json", by_alias=True)
    return dict(metadata) if isinstance(metadata, dict) else None


def _invoke_sync_remote(
    remote: Any, *, user_id: str, session_id: str,
    seeded_state: dict[str, Any], prompt: str,
) -> dict[str, Any]:
    try:
        session = remote.create_session(
            user_id=user_id, session_id=session_id, state=seeded_state,
        )
    except Exception as create_exc:
        try:
            session = remote.get_session(user_id=user_id, session_id=session_id)
        except Exception:
            raise create_exc
        if session is None:
            raise create_exc
    if _session_id(session) != session_id:
        raise AgentEngineProtocolError("Agent Engine returned the wrong managed session")
    state: dict[str, Any] = {}
    try:
        for event in remote.stream_query(
            user_id=user_id, session_id=session_id, message=prompt,
        ):
            state.update(_state_delta(event))
            if metadata := _grounding_metadata(event):
                state["_adk_grounding_metadata"] = metadata
    except Exception:
        # Agent Engine may durably commit the specialist handoff before its SSE
        # transport terminates. Recover only state that differs from our seed;
        # downstream specialist validators still fail closed on partial output.
        recovered = _persisted_delta(
            remote.get_session(user_id=user_id, session_id=session_id), seeded_state,
        )
        if not recovered:
            raise
        state.update(recovered)
    return state


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
            client = vertexai.Client(http_options={"timeout": 300_000})
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
                prompt = json.dumps(
                    {key: value for key, value in payload.items() if not key.startswith("_")},
                    separators=(",", ":"), sort_keys=True,
                )
                if all(callable(getattr(remote, name, None)) for name in (
                    "get_session", "create_session", "stream_query",
                )):
                    state.update(await asyncio.to_thread(
                        _invoke_sync_remote, remote, user_id=user_id,
                        session_id=session_id, seeded_state=seeded_state, prompt=prompt,
                    ))
                else:
                    try:
                        session = await remote.async_get_session(
                            user_id=user_id, session_id=session_id,
                        )
                    except Exception as exc:  # provider SDK wraps this in multiple exception types
                        if not _is_missing_session_error(exc):
                            raise
                        session = None
                    if session is None:
                        try:
                            session = await remote.async_create_session(
                                user_id=user_id, session_id=session_id, state=seeded_state,
                            )
                        except Exception as create_exc:  # a concurrent creator may have won
                            try:
                                session = await remote.async_get_session(
                                    user_id=user_id, session_id=session_id,
                                )
                            except Exception as get_exc:
                                if _is_missing_session_error(get_exc):
                                    raise create_exc
                                raise
                            if session is None:
                                raise create_exc
                    if _session_id(session) != session_id:
                        raise AgentEngineProtocolError("Agent Engine returned the wrong managed session")
                    try:
                        events: AsyncIterator[Any] = remote.async_stream_query(
                            user_id=user_id,
                            session_id=session_id,
                            message=prompt,
                        )
                        async for event in events:
                            state.update(_state_delta(event))
                            if metadata := _grounding_metadata(event):
                                state["_adk_grounding_metadata"] = metadata
                    except Exception:
                        recovered = _persisted_delta(
                            await remote.async_get_session(
                                user_id=user_id, session_id=session_id,
                            ),
                            seeded_state,
                        )
                        if not recovered:
                            raise
                        state.update(recovered)
            except AgentEngineProtocolError:
                raise
            except Exception as exc:  # noqa: BLE001 - normalized at provider boundary
                raise AgentEngineProviderError(f"Agent Engine invocation failed: {exc}") from exc
            if not state:
                raise AgentEngineProtocolError("Agent Engine returned no state delta")
            span.set_attribute("state.key_count", len(state))
            return state
