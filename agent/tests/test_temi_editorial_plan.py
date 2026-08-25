"""Strict boundary contracts for Temi planning and Noni production handoff."""

from __future__ import annotations

from copy import deepcopy

import pytest
from pydantic import ValidationError

from harmonia_agent.agent_models import (
    EditorialPlan,
    EditorialPlannerInput,
    ProductionDraftInput,
)


def strategy() -> dict:
    return {
        "strategyId": "strategy-job-1-v1", "version": 1, "horizonWeeks": 4,
        "thesis": "Lead with verified operating proof.",
        "differentiatedNarrative": "Harmonia connects evidence to governed execution.",
        "objectives": [{"text": "Increase qualified demos", "evidenceRefs": ["ctx-campaign"]}],
        "audiencePriorities": [{"audienceId": "aud-founders", "priority": 1, "reason": "Founders own the bottleneck", "evidenceRefs": ["ctx-campaign"]}],
        "funnelIntent": "consideration", "intendedConversions": ["request a product demo"],
        "pillars": [{"name": "operational proof", "purpose": "Demonstrate measurable gains", "evidenceRefs": ["m1", "perf-1"]}],
        "campaignThemes": [{"name": "From delay to flow", "message": "Governance can accelerate delivery", "evidenceRefs": ["m1"]}],
        "channelRoles": [{"channel": "x", "role": "proof-led discovery", "operationallySupported": True, "formats": ["text_post"], "cadence": "2 posts per week", "evidenceRefs": ["ctx-campaign"]}],
        "contentMix": [{"format": "text_post", "percentage": 100}],
        "cadenceGuidance": "Two supported-channel items per week.",
        "priorityRules": ["Prefer quantified source proof"],
        "ctaGuidance": ["Invite qualified operators to request a demo"],
        "kpis": [{"name": "qualified demo requests", "target": "measure weekly", "measurement": "verified attributed requests", "evidenceRefs": ["ctx-campaign"]}],
        "successCriteria": ["At least one verified qualified demo request"],
        "constraints": ["Use only supplied evidence"], "exclusions": ["Unsupported outcome claims"],
        "brandSafety": ["Never imply autonomous approval"],
        "briefs": [{
            "id": "brief-1", "title": "Nine days to forty hours", "objective": "Show operational proof",
            "audienceId": "aud-founders", "funnelStage": "consideration", "keyMessage": "Governed workflows reduce activation delay",
            "channelCandidates": ["x"], "formatCandidates": ["text_post"],
            "ctaIntent": "request a demo", "intendedConversion": "qualified demo request", "kpi": "qualified demo requests",
            "priority": 1, "dependencies": [], "constraints": ["Quote the source exactly"],
            "evidenceRefs": ["m1", "ctx-campaign"],
        }],
        "assumptions": [], "confidence": "high",
    }


def analysis() -> dict:
    return {
        "summary": "Activation time fell from nine days to forty hours.",
        "moments": [{"id": "m1", "title": "Activation", "startSec": 2, "endSec": 8, "hook": "Nine days to forty hours", "quote": "we cut nine days to forty hours"}],
        "angles": [{"id": "a1", "kind": "trend", "title": "Operational speed", "rationale": "The source demonstrates measurable improvement."}],
    }


def plan() -> dict:
    return {
        "planId": "plan-job-1-v1", "version": 1, "approvedStrategyDigest": "a" * 64,
        "horizonStartAt": "2026-08-31T00:00:00Z", "horizonEndAt": "2026-09-28T00:00:00Z",
        "timezone": "America/Los_Angeles", "summary": "A four-week proof-led campaign.",
        "sequencingRationale": "Start with the strongest source proof.",
        "cadenceRationale": "One focused item begins the approved horizon.",
        "assumptions": ["The verified audience remains available during the horizon."], "confidence": "high",
        "selectedNextItemId": "item-1",
        "items": [{
            "id": "item-1", "briefId": "brief-1", "campaignTheme": "From delay to flow", "contentPillar": "operational proof",
            "objective": "Show operational proof", "audienceId": "aud-founders", "funnelStage": "consideration",
            "intendedConversion": "qualified demo request", "ctaIntent": "request a demo", "kpi": "qualified demo requests",
            "channel": "x", "format": "text_post", "evidenceRefs": ["m1", "ctx-campaign"],
            "publicationWindowStartAt": "2026-09-01T16:00:00Z", "publicationWindowEndAt": "2026-09-01T18:00:00Z",
            "productionDeadlineAt": "2026-08-31T18:00:00Z", "priority": 1, "selectionScore": 0.9,
            "dependencies": [], "productionStatus": "planned", "constraints": ["Quote the source exactly"],
            "requiredAssets": ["source-clip"], "planningRationale": "The first proof post opens the campaign.",
            "selectionRationale": "This is the highest-priority unblocked brief.", "confidence": "high",
        }],
    }


def planner_input() -> dict:
    return {
        "strategy": strategy(), "strategyDigest": "a" * 64, "strategyVersion": 1,
        "strategyApproval": {"decision": "approved", "payloadDigest": "a" * 64, "revision": 1, "actorSubjectId": "operator-1", "decidedAt": "2026-08-30T00:00:00Z", "expiresAt": "2026-08-31T00:00:00Z"},
        "analysis": analysis(), "horizonStartAt": "2026-08-31T00:00:00Z", "horizonEndAt": "2026-09-28T00:00:00Z", "timezone": "America/Los_Angeles",
        "channelCapabilities": [{"channel": "x", "formats": ["text_post"]}],
        "existingCommitments": [{"id": "commitment-1", "channel": "x", "publicationWindowStartAt": "2026-09-03T16:00:00Z", "publicationWindowEndAt": "2026-09-03T18:00:00Z"}],
        "productionCapacity": {"maxItems": 8, "maxItemsPerWeek": 2},
        "cadenceConstraints": {"minimumHoursBetweenItems": 24, "maxItemsPerChannelPerWeek": 2},
        "postingWindowObservations": [{"id": "window-1", "channel": "x", "format": "text_post", "observedAt": "2026-08-29T00:00:00Z", "evidenceRefs": ["perf-1"]}],
        "revision": 1,
    }


def production_input() -> dict:
    return {
        "planId": "plan-job-1-v1", "strategyDigest": "a" * 64, "editorialItem": plan()["items"][0],
        "brief": strategy()["briefs"][0], "referencedMoments": analysis()["moments"],
        "referencedAngles": [], "brandContext": "Use a direct, evidence-led voice.",
        "constraints": ["Quote the source exactly", "Never imply autonomous approval"],
    }


def test_complete_strict_temi_contracts_are_accepted():
    assert EditorialPlannerInput.model_validate(planner_input()).timezone == "America/Los_Angeles"
    assert EditorialPlan.model_validate(plan()).selectedNextItemId == "item-1"
    assert ProductionDraftInput.model_validate(production_input()).editorialItem.id == "item-1"


@pytest.mark.parametrize(("model", "payload", "field"), [
    (EditorialPlannerInput, planner_input, "strategyApproval"),
    (EditorialPlan, plan, "sequencingRationale"),
    (ProductionDraftInput, production_input, "brief"),
])
def test_temi_contracts_require_every_boundary_field(model, payload, field):
    invalid = deepcopy(payload())
    del invalid[field]
    with pytest.raises(ValidationError):
        model.model_validate(invalid)


def test_plan_requires_exactly_one_selected_item_and_planned_production_state():
    invalid = plan()
    invalid["selectedNextItemId"] = "missing-item"
    with pytest.raises(ValidationError, match="selectedNextItemId"):
        EditorialPlan.model_validate(invalid)

    invalid = plan()
    invalid["items"][0]["productionStatus"] = "selected"
    with pytest.raises(ValidationError):
        EditorialPlan.model_validate(invalid)


@pytest.mark.parametrize(("payload", "field"), [
    (plan, "finalPostCopy"),
    (plan, "externalEventId"),
    (plan, "receipt"),
    (production_input, "publishPayload"),
])
def test_temi_contracts_reject_copy_and_external_effect_authority(payload, field):
    invalid = deepcopy(payload())
    invalid[field] = "forbidden"
    model = EditorialPlan if payload is plan else ProductionDraftInput
    with pytest.raises(ValidationError, match="extra_forbidden"):
        model.model_validate(invalid)


def test_temi_contracts_require_utc_horizon_boundaries_and_an_iana_timezone():
    invalid = planner_input()
    invalid["horizonStartAt"] = "2026-08-31T00:00:00+01:00"
    with pytest.raises(ValidationError, match="UTC"):
        EditorialPlannerInput.model_validate(invalid)

    invalid = plan()
    invalid["timezone"] = "not/a-timezone"
    with pytest.raises(ValidationError, match="IANA"):
        EditorialPlan.model_validate(invalid)
