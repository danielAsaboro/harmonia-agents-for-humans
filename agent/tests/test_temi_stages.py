"""Temi has a distinct planning stage before Noni production."""

from __future__ import annotations

import asyncio

import pytest

from harmonia_agent import stages
from harmonia_agent.agent_models import EditorialPlan
from tests.test_ryan_stages import job as ryan_job
from tests.test_ryan_strategy import strategy
from tests.test_temi_editorial_plan import plan


def approved_job() -> dict:
    source = ryan_job()
    source.update({
        "stage": "plan", "contentStrategy": strategy().model_dump(mode="json"),
        "strategyDigest": "a" * 64, "strategyRevision": 1,
        "strategyApprovalState": "approved",
        "strategyApproval": {"decision": "approved", "payloadDigest": "a" * 64, "revision": 1,
                             "actorSubjectId": "operator-1", "decidedAt": "2026-08-30T00:00:00Z",
                             "expiresAt": "2026-08-31T00:00:00Z"},
    })
    return source


def test_editorial_plan_digest_is_canonical_and_matches_typescript():
    assert stages.editorial_plan_digest({"b": 2, "a": 1}) == stages.editorial_plan_digest({"a": 1, "b": 2})
    assert stages.editorial_plan_digest({"a": 1, "b": 2}) == "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"


def test_plan_runs_temi_and_persists_complete_plan_before_any_draft(monkeypatch):
    calls, posts = [], []

    async def fake_plan(request, *, invocation):
        calls.append((request, invocation))
        return EditorialPlan.model_validate(plan())

    monkeypatch.setattr(stages, "get_job", lambda _id: approved_job())
    monkeypatch.setattr(stages, "plan_with_team", fake_plan)
    monkeypatch.setattr(stages, "draft_with_team", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("Noni ran before plan persistence")))
    monkeypatch.setattr(stages, "web_post", lambda path, payload: posts.append((path, payload)))

    asyncio.run(stages.run_plan("job-1"))

    request, invocation = calls[0]
    assert request.strategyDigest == "a" * 64
    assert request.strategyApproval.payloadDigest == request.strategyDigest
    assert invocation.stage == "plan"
    assert posts == [("/api/internal/editorial-plan", {
        "jobId": "job-1", "stage": "plan", "revision": 1,
        "plan": plan(), "modelUsed": stages.content.model_used(),
    })]


def test_planning_failure_prevents_persistence_and_draft_dispatch(monkeypatch):
    posts = []

    async def fail_plan(*_args, **_kwargs):
        raise RuntimeError("planning failed")

    monkeypatch.setattr(stages, "get_job", lambda _id: approved_job())
    monkeypatch.setattr(stages, "plan_with_team", fail_plan)
    monkeypatch.setattr(stages, "web_post", lambda path, payload: posts.append((path, payload)))

    with pytest.raises(RuntimeError, match="planning failed"):
        asyncio.run(stages.run_plan("job-1"))
    assert posts == []
