"""Exact-scope, durable context through Vertex AI Agent Engine Memory Bank."""

from __future__ import annotations

from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field

from .telemetry import safe_attributes, tracer


class MemoryProtocolError(RuntimeError):
    """Memory Bank returned a malformed response or an ineligible write."""


class MemoryProviderError(RuntimeError):
    """Memory Bank transport or provider execution failed."""


class MemoryScope(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    workspace_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._-]+$")
    brand_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._-]+$")

    def to_wire(self) -> dict[str, str]:
        return {"workspace_id": self.workspace_id, "brand_id": self.brand_id}


class MemoryCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["operator_decision", "verified_outcome", "learning", "preference"]
    fact: str = Field(min_length=1, max_length=1000)


class MemoryBank(Protocol):
    def retrieve(self, *, scope: MemoryScope, query: str, top_k: int = 3) -> list[str]: ...

    def generate(self, *, scope: MemoryScope, candidates: list[MemoryCandidate]) -> None: ...


def _fact_from_result(result: Any) -> str | None:
    if isinstance(result, dict):
        memory = result.get("memory") or {}
        return memory.get("fact") if isinstance(memory, dict) else getattr(memory, "fact", None)
    memory = getattr(result, "memory", None)
    return getattr(memory, "fact", None)


class VertexMemoryBank:
    def __init__(self, *, resource_name: str, client: Any | None = None) -> None:
        if not resource_name.startswith("projects/") or "/reasoningEngines/" not in resource_name:
            raise ValueError("MEMORY_BANK_RESOURCE must be a full reasoning engine resource name")
        self.resource_name = resource_name
        self._client = client

    def _memories(self) -> Any:
        client = self._client
        if client is None:
            try:
                import vertexai
            except ImportError as exc:  # pragma: no cover - deployment dependency
                raise MemoryProviderError(
                    "google-cloud-aiplatform Memory Bank support is not installed"
                ) from exc
            client = vertexai.Client()
        return client.agent_engines.memories

    def retrieve(self, *, scope: MemoryScope, query: str, top_k: int = 3) -> list[str]:
        if not query.strip():
            return []
        bounded_top_k = min(max(top_k, 1), 5)
        with tracer().start_as_current_span("harmonia.memory.retrieve") as span:
            span.set_attributes(safe_attributes({
                "workspace.id": scope.workspace_id,
                "brand.id": scope.brand_id,
                "memory.top_k": bounded_top_k,
            }))
            try:
                results = self._memories().retrieve(
                    name=self.resource_name,
                    scope=scope.to_wire(),
                    similarity_search_params={
                        "search_query": query[:1000],
                        "top_k": bounded_top_k,
                    },
                )
                facts: list[str] = []
                for result in results:
                    fact = _fact_from_result(result)
                    if not isinstance(fact, str) or not fact.strip():
                        raise MemoryProtocolError("Memory Bank result is missing a valid fact")
                    facts.append(fact.strip()[:1000])
                span.set_attribute("memory.result_count", len(facts))
                return facts
            except MemoryProtocolError:
                raise
            except Exception as exc:  # noqa: BLE001 - provider boundary
                raise MemoryProviderError(f"Memory Bank retrieval failed: {exc}") from exc

    def generate(self, *, scope: MemoryScope, candidates: list[MemoryCandidate]) -> None:
        if not candidates:
            return
        if len(candidates) > 5:
            raise MemoryProtocolError("Memory Bank accepts at most five eligible facts per write")
        validated = [MemoryCandidate.model_validate(candidate) for candidate in candidates]
        with tracer().start_as_current_span("harmonia.memory.generate") as span:
            span.set_attributes(safe_attributes({
                "workspace.id": scope.workspace_id,
                "brand.id": scope.brand_id,
                "memory.fact_count": len(validated),
            }))
            try:
                self._memories().generate(
                    name=self.resource_name,
                    scope=scope.to_wire(),
                    direct_memories_source={
                        "direct_memories": [{"fact": item.fact} for item in validated],
                    },
                )
            except Exception as exc:  # noqa: BLE001 - provider boundary
                raise MemoryProviderError(f"Memory Bank generation failed: {exc}") from exc


def format_memory_context(facts: list[str], *, max_chars: int = 3500) -> str:
    """Bound retrieved facts before they enter an agent input contract."""
    lines: list[str] = []
    used = 0
    for fact in facts[:5]:
        line = f"- {fact.strip()}"
        if not fact.strip() or used + len(line) > max_chars:
            break
        lines.append(line)
        used += len(line) + 1
    return "\n".join(lines)


def eligible_job_memories(job: dict[str, Any], *, measured_posts: int) -> list[MemoryCandidate]:
    """Extract only durable decisions/outcomes; never raw creative or source content."""
    actions = job.get("actions") or []
    approved = sum(1 for action in actions if action.get("approvalState") == "approved")
    rejected = sum(1 for action in actions if action.get("approvalState") == "rejected")
    verifications = job.get("verifications") or job.get("verification") or []
    verified = sum(1 for result in verifications if result.get("verified") is True)
    candidates: list[MemoryCandidate] = []
    if approved or rejected:
        candidates.append(MemoryCandidate(
            kind="operator_decision",
            fact=f"Operator approved {approved} action(s) and rejected {rejected} action(s) in this job.",
        ))
    if verified:
        candidates.append(MemoryCandidate(
            kind="verified_outcome",
            fact=f"The job independently verified {verified} external or stored outcome(s).",
        ))
    candidates.append(MemoryCandidate(
        kind="learning",
        fact=f"The learn stage measured {measured_posts} published post(s) for this job.",
    ))
    return candidates
