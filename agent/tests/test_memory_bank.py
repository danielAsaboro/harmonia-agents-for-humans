"""Exact-scope Memory Bank behavior and eligible fact generation."""

from __future__ import annotations

import pytest

from harmonia_agent.memory_bank import (
    MemoryCandidate,
    MemoryEvidenceRef,
    MemoryFact,
    MemoryProtocolError,
    MemoryScope,
    AgentCoreMemoryBank,
    eligible_job_memories,
)
from harmonia_agent.agent_models import AnalystInput
from harmonia_agent.agents import analyze_with_team
import asyncio
from tests.test_nimi_contracts import analyst_input


class _MemoryApi:
    def __init__(self, results=None):
        self.results = results or []
        self.retrieve_calls, self.generate_calls = [], []
    def retrieve_memory_records(self, **kwargs):
        self.retrieve_calls.append(kwargs)
        return {"memoryRecordSummaries": self.results}
    def batch_create_memory_records(self, **kwargs):
        self.generate_calls.append(kwargs)
        return {"successfulRecords": [{"requestIdentifier": item["requestIdentifier"]} for item in kwargs["records"]]}








def test_memory_bank_retrieves_only_the_exact_workspace_and_brand_scope():
    api = _MemoryApi(results=[
        {"namespaces": ["/harmonia/workspace-1/brand-a/facts"], "content": {"text": '{"recorded_at":"2026-09-09T10:00:00Z","evidence_ref":{"brand_id":"brand-a","job_id":"job-1","kind":"decision","record_id":"a1","workspace_id":"workspace-1"},"fact":"Operators prefer direct, evidence-led hooks.","kind":"preference"}'}},
    ])
    bank = AgentCoreMemoryBank(
        memory_id="harmonia-1234567890",
        client=api,
    )
    scope = MemoryScope(workspace_id="workspace-1", brand_id="brand-a")

    facts = bank.retrieve(scope=scope, query="video launch", top_k=3)

    assert facts == [MemoryFact(recorded_at="2026-09-09T10:00:00Z", kind="preference", fact="Operators prefer direct, evidence-led hooks.", evidence_ref=MemoryEvidenceRef(workspace_id="workspace-1", brand_id="brand-a", job_id="job-1", kind="decision", record_id="a1"))]
    assert api.retrieve_calls == [{"memoryId": "harmonia-1234567890", "namespace": "/harmonia/workspace-1/brand-a/facts", "searchCriteria": {"searchQuery": "video launch", "topK": 3}}]


def test_memory_bank_generates_only_typed_eligible_facts_in_the_same_scope():
    api = _MemoryApi()
    bank = AgentCoreMemoryBank(
        memory_id="harmonia-1234567890",
        client=api,
    )
    scope = MemoryScope(workspace_id="workspace-1", brand_id="brand-a")

    bank.generate(scope=scope, candidates=[
        MemoryCandidate(recorded_at="2026-09-09T10:00:00Z", kind="operator_decision", fact="Operator approved one publish action.", evidence_ref=MemoryEvidenceRef(workspace_id="workspace-1", brand_id="brand-a", job_id="job-1", kind="decision", record_id="a1")),
        MemoryCandidate(recorded_at="2026-09-09T10:00:00Z", kind="verified_outcome", fact="One published post was independently verified.", evidence_ref=MemoryEvidenceRef(workspace_id="workspace-1", brand_id="brand-a", job_id="job-1", kind="verification", record_id="a1")),
    ])

    assert len(api.generate_calls) == 1
    records = api.generate_calls[0]["records"]
    assert len(records) == 2
    assert all(record["namespaces"] == ["/harmonia/workspace-1/brand-a/facts"] for record in records)
    assert len(api.generate_calls[0]["clientToken"]) == 64
    assert 'Operator approved' in records[0]["content"]["text"]


def test_memory_bank_rejects_malformed_results_instead_of_hiding_them():
    bank = AgentCoreMemoryBank(
        memory_id="harmonia-1234567890",
        client=_MemoryApi(results=[{"distance": 0.1}]),
    )
    with pytest.raises(MemoryProtocolError, match="namespace"):
        bank.retrieve(
            scope=MemoryScope(workspace_id="workspace-1", brand_id="brand-a"),
            query="launch",
        )


def test_learn_stage_memory_candidates_exclude_raw_content_and_unverified_claims():
    candidates = eligible_job_memories({
        "id": "job-1", "workspaceId": "workspace-1", "brandId": "brand-a", "updatedAt": "2026-09-09T10:00:00Z",
        "actions": [
            {"id": "a1", "type": "publish_x_post", "approvalState": "approved", "state": "executed",
             "payload": {"text": "raw draft must never be memorized"}},
            {"id": "a2", "type": "generate_image", "approvalState": "rejected", "state": "skipped",
             "payload": {"prompt": "raw prompt must never be memorized"}},
        ],
        "verification": [
            {"actionId": "a1", "verified": True, "target": "x:123"},
            {"actionId": "a2", "verified": False, "target": "asset:a2"},
        ],
    }, measured_posts=1)

    facts = " ".join(candidate.fact for candidate in candidates)
    assert "raw draft" not in facts
    assert "raw prompt" not in facts
    assert "approved 1" in facts
    assert "rejected 1" in facts
    assert "independently verified 1" in facts
    assert all(candidate.evidence_ref.workspace_id == "workspace-1" for candidate in candidates)
    assert {candidate.evidence_ref.kind for candidate in candidates} == {"decision", "verification"}


def test_memory_generation_rejects_cross_scope_evidence():
    bank = AgentCoreMemoryBank(
        memory_id="harmonia-1234567890",
        client=_MemoryApi(),
    )
    with pytest.raises(MemoryProtocolError, match="scope"):
        bank.generate(scope=MemoryScope(workspace_id="workspace-1", brand_id="brand-a"), candidates=[
            MemoryCandidate(recorded_at="2026-09-09T10:00:00Z", kind="preference", fact="Use concise hooks.", evidence_ref=MemoryEvidenceRef(workspace_id="workspace-2", brand_id="brand-a", job_id="job-1", kind="decision", record_id="a1")),
        ])


@pytest.fixture(autouse=True)
def allow_offline_memory_doubles(monkeypatch):
    monkeypatch.setenv("HARMONIA_ALLOW_PAID_AWS", "true")
