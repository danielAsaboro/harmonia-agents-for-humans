"""Exact-scope, durable context through Amazon Bedrock AgentCore Memory."""

from __future__ import annotations

import json
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, AwareDatetime

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
    recorded_at: AwareDatetime
    kind: Literal["operator_decision", "verified_outcome", "learning", "preference"]
    fact: str = Field(min_length=1, max_length=1000)
    evidence_ref: "MemoryEvidenceRef"


class MemoryEvidenceRef(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    workspace_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._-]+$")
    brand_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._-]+$")
    job_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._-]+$")
    kind: Literal["decision", "receipt", "verification", "learning"]
    record_id: str = Field(min_length=1, max_length=240, pattern=r"^[A-Za-z0-9._:-]+$")


class MemoryFact(MemoryCandidate):
    pass


class MemoryBank(Protocol):
    def retrieve(self, *, scope: MemoryScope, query: str, top_k: int = 3) -> list[MemoryFact]: ...

    def generate(self, *, scope: MemoryScope, candidates: list[MemoryCandidate]) -> None: ...


class AgentCoreMemoryBank:
    def __init__(self, *, memory_id: str, client: Any | None = None) -> None:
        if not memory_id.strip():
            raise ValueError("AGENTCORE_MEMORY_ID is required")
        self.memory_id, self._client = memory_id, client

    def _api(self):
        import boto3
        import os
        from .aws_authority import require_paid_aws
        require_paid_aws("AgentCore Memory")
        return self._client or boto3.client("bedrock-agentcore", region_name=os.environ.get("AWS_REGION", "us-east-1"))

    @staticmethod
    def namespace(scope: MemoryScope) -> str:
        return f"/harmonia/{scope.workspace_id}/{scope.brand_id}/facts"

    def retrieve(self, *, scope: MemoryScope, query: str, top_k: int = 3) -> list[MemoryFact]:
        if not query.strip():
            return []
        try:
            response = self._api().retrieve_memory_records(
                memoryId=self.memory_id, namespace=self.namespace(scope),
                searchCriteria={"searchQuery": query[:1000], "topK": min(max(top_k, 1), 5)},
            )
            facts = []
            for record in response.get("memoryRecordSummaries", []):
                if self.namespace(scope) not in record.get("namespaces", []):
                    raise MemoryProtocolError("AgentCore returned a cross-scope namespace")
                fact = MemoryFact.model_validate_json(record["content"]["text"])
                if fact.evidence_ref.workspace_id != scope.workspace_id or fact.evidence_ref.brand_id != scope.brand_id:
                    raise MemoryProtocolError("AgentCore returned cross-scope evidence")
                facts.append(fact)
            return facts
        except (MemoryProtocolError, PermissionError):
            raise
        except Exception as exc:
            raise MemoryProviderError(f"AgentCore Memory retrieval failed: {type(exc).__name__}") from exc

    def generate(self, *, scope: MemoryScope, candidates: list[MemoryCandidate]) -> None:
        if not candidates:
            return
        if len(candidates) > 5:
            raise MemoryProtocolError("Memory accepts at most five eligible facts per write")
        validated = [MemoryCandidate.model_validate(item) for item in candidates]
        if any(item.evidence_ref.workspace_id != scope.workspace_id or item.evidence_ref.brand_id != scope.brand_id for item in validated):
            raise MemoryProtocolError("Memory candidate evidence does not match scope")
        from hashlib import sha256
        records = []
        for item in validated:
            content = json.dumps(item.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
            records.append({"requestIdentifier": sha256(content.encode()).hexdigest(),
                            "content": {"text": content}, "namespaces": [self.namespace(scope)], "timestamp": item.recorded_at})
        try:
            response = self._api().batch_create_memory_records(memoryId=self.memory_id,
                clientToken=sha256(json.dumps(records, sort_keys=True, default=str).encode()).hexdigest(), records=records)
            if response.get("failedRecords") or len(response.get("successfulRecords", [])) != len(records):
                raise MemoryProtocolError("AgentCore Memory write incomplete; reconcile records before retry")
        except (MemoryProtocolError, PermissionError):
            raise
        except Exception as exc:
            raise MemoryProviderError(f"AgentCore Memory write outcome unresolved: {type(exc).__name__}") from exc


def format_memory_context(facts: list[MemoryFact], *, max_chars: int = 3500) -> str:
    """Bound retrieved facts before they enter an agent input contract."""
    lines: list[str] = []
    used = 0
    for fact in facts[:5]:
        line = f"- {fact.fact.strip()} [evidence:{fact.evidence_ref.kind}/{fact.evidence_ref.record_id}]"
        if not fact.fact.strip() or used + len(line) > max_chars:
            break
        lines.append(line)
        used += len(line) + 1
    return "\n".join(lines)


def eligible_job_memories(job: dict[str, Any], *, measured_posts: int) -> list[MemoryCandidate]:
    """Extract only durable decisions/outcomes; never raw creative or source content."""
    # Engagement is not durable until the later web write succeeds, so this pre-write
    # memory step deliberately does not claim `measured_posts` as evidence.
    _ = measured_posts
    actions = job.get("actions") or []
    workspace_id = str(job.get("workspaceId") or "")
    brand_id = str(job.get("brandId") or "")
    job_id = str(job.get("id") or "")
    if not workspace_id or not brand_id or not job_id:
        raise MemoryProtocolError("eligible memory job is missing durable scope identifiers")
    recorded_at = job.get("updatedAt") or job.get("createdAt")
    if not recorded_at:
        raise MemoryProtocolError("eligible memory job requires a durable recorded timestamp")
    verifications = job.get("verifications") or job.get("verification") or []
    candidates: list[MemoryCandidate] = []
    for action in actions:
        decision = action.get("approvalState")
        action_id = action.get("id")
        if decision not in {"approved", "rejected"} or not action_id:
            continue
        candidates.append(MemoryCandidate(
            recorded_at=recorded_at,
            kind="operator_decision",
            fact=f"Operator {decision} 1 action in this job.",
            evidence_ref=MemoryEvidenceRef(
                workspace_id=workspace_id, brand_id=brand_id, job_id=job_id,
                kind="decision", record_id=str(action_id),
            ),
        ))
    for result in verifications:
        record_id = result.get("actionId") or result.get("target")
        if result.get("verified") is not True or not record_id:
            continue
        candidates.append(MemoryCandidate(
            recorded_at=recorded_at,
            kind="verified_outcome",
            fact="The job independently verified 1 external or stored outcome.",
            evidence_ref=MemoryEvidenceRef(
                workspace_id=workspace_id, brand_id=brand_id, job_id=job_id,
                kind="verification", record_id=str(record_id),
            ),
        ))
    return candidates[:5]
