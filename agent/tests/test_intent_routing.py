from __future__ import annotations

import pytest
import json
import subprocess
from pathlib import Path
from pydantic import ValidationError

from harmonia_agent.intent_routing import (
    IntentRoute,
    deterministic_intent_classification,
    IntentRoutingInput,
    source_urls_from_input,
)


def test_explicit_source_repurpose_is_host_classified_without_model_judgment():
    value = IntentRoutingInput.model_validate({
        "message": "Repurpose https://www.youtube.com/watch?v=aqz-KE-bpKQ into a LinkedIn post and exportable content package. Do not publish.",
        "attachmentCount": 0,
        "workspaceContext": {
            "strategyReady": False, "planReady": False, "calendarReady": False,
            "pendingApprovalCount": 0, "goals": [], "channels": [],
            "strategySummary": None, "planSummary": None,
            "upcomingItemCount": 0, "recentJobs": [],
        },
    })

    route = deterministic_intent_classification(value)

    assert route is not None
    assert route.intent == "repurpose_source"
    assert route.sourceUrls == ["https://www.youtube.com/watch?v=aqz-KE-bpKQ"]
    assert route.outputConcepts == ["professional_post", "content_package"]
    assert route.platformRecommendations == ["linkedin"]
    assert route.requiresRightsAttestation is True
    assert route.effectRequested is False


def context(**overrides):
    base = {
        "strategyReady": False,
        "planReady": False,
        "calendarReady": False,
        "pendingApprovalCount": 0,
        "recentJobs": [],
        "goals": [],
        "channels": [],
    }
    return {**base, **overrides}


def test_work_placement_is_not_bypassed_by_explicit_source_syntax():
    for message in ["Repurpose https://example.com for the existing campaign Launch", "Analyze https://example.com as knowledge only"]:
        value = IntentRoutingInput(message=message, workspaceContext=context(), attachmentCount=0)
        assert deterministic_intent_classification(value) is None


def test_operation_projection_is_strict_and_accepts_current_jobs_proposals_and_all_durable_states():
    payload = IntentRoutingInput.model_validate({
        "message": "status", "attachmentCount": 0,
        "workspaceContext": context(operation={
            "activeStrategy": {"thesis": "Evidence-led growth", "strategyId": "strategy-1", "revision": 2, "digest": "a" * 64},
            "proposedChanges": [{"id": "content-1", "kind": "content", "status": "proposed", "changes": ["topic=launch", "angle=proof"], "evidenceRefs": ["source-1"]}, {"id": "plan-1", "kind": "planning", "status": "declined", "changes": ["{}"], "evidenceRefs": [], "decision": "keep_existing_execution"}],
            "campaigns": [{"id": "campaign-1", "name": "Launch", "objective": "Earn trust"}],
            "plans": [{"id": "plan-1", "revision": 2, "reason": "Current calendar"}],
            "plannedItems": [{"id": "item-1", "planId": "plan-1", "campaignId": None, "campaignLabel": "Independent work", "name": "Founder note", "objective": "Explain the launch", "channel": "x", "scheduledFor": "2026-09-11T10:00:00Z", "strategyRef": {"strategyId": "strategy-1", "revision": 2, "digest": "a" * 64}, "metricIds": ["engagement"], "sourceEvidenceRefs": ["segment-1"], "declaredDependencies": ["asset-1:v1"], "requiredAssets": ["asset-1"], "evidenceState": "source_backed", "approvalState": "pending", "lifecycleState": "requires_disposition", "unresolvedDependencies": ["proposal pending"]}],
            "results": [{"id": "result-1", "metric": "engagement", "availability": "failed", "checkedAt": "2026-09-11T10:00:00Z"}, {"id": "result-2", "metric": "reach", "availability": "pending_window"}],
            "currentJobs": [{"id": "job-1", "stage": "draft", "status": "running"}],
        }),
    })
    assert payload.workspaceContext.operation is not None
    assert payload.workspaceContext.operation.currentJobs[0].id == "job-1"
    assert payload.workspaceContext.operation.plannedItems[0].lifecycleState == "requires_disposition"
    assert payload.workspaceContext.operation.results[0].availability == "failed"

    invalid = payload.model_dump(mode="json")
    invalid["workspaceContext"]["operation"]["currentJobs"][0]["invented"] = "no"
    with pytest.raises(ValidationError):
        IntentRoutingInput.model_validate(invalid)


def test_actual_typescript_workspace_projection_round_trips_to_strict_python_router():
    root = Path(__file__).resolve().parents[2]
    script = r'''import { projectWorkspaceContentContext } from "./src/lib/workspaceContentContext.ts";
const d="a".repeat(64); const value=projectWorkspaceContentContext({goals:{topics:[]},jobs:[{id:"job-1",stage:"draft",status:"running"}],items:[],activeStrategy:null,plannedItems:[{ref:{id:"item-1",revision:1},planRef:{id:"plan-1",revision:1},campaignRef:null,strategyRef:{strategyId:"strategy-1",revision:1,digest:d},name:"One",objective:"Explain",channel:"x",scheduledFor:"2026-09-11T10:00:00Z",measurements:[{definition:{id:"engagement"}}],dependencies:[],requiredAssetIds:[],evidence:{mode:"source_backed",sourceBinding:{evidenceIds:["evidence-1"]}},lifecycle:{status:"awaiting_approval"}}]}); console.log(JSON.stringify({message:"status",attachmentCount:0,workspaceContext:value}));'''
    serialized = subprocess.run([str(root / "node_modules/.bin/tsx"), "-e", script], cwd=root, capture_output=True, text=True, check=True).stdout
    validated = IntentRoutingInput.model_validate(json.loads(serialized))
    assert validated.workspaceContext.operation is not None
    assert validated.workspaceContext.operation.plannedItems[0].strategyRef.strategyId == "strategy-1"

    invalid = json.loads(serialized)
    invalid["workspaceContext"]["operation"]["plannedItems"][0]["strategyRef"]["thesis"] = "not an item ref"
    with pytest.raises(ValidationError):
        IntentRoutingInput.model_validate(invalid)


def test_router_does_not_invent_default_outputs():
    value = IntentRoutingInput(message="Repurpose https://example.com", workspaceContext=context(), attachmentCount=0)
    assert deterministic_intent_classification(value) is None


def test_direct_media_request_is_routed_without_substituting_a_social_post():
    value = IntentRoutingInput(
        message="Generate a social image, a generated video, and instrumental music for the launch.",
        workspaceContext=context(),
        attachmentCount=0,
    )

    route = deterministic_intent_classification(value)

    assert route is not None
    assert route.intent == "one_off_content"
    assert route.outputConcepts == ["social_image", "generated_video", "generated_music"]
    assert route.platformRecommendations == []
    assert route.effectRequested is False


def test_ordinary_media_words_preserve_all_requested_outputs():
    route = deterministic_intent_classification(IntentRoutingInput(
        message="Make an image, video and music for launch day.",
        workspaceContext=context(),
        attachmentCount=0,
    ))
    assert route is not None
    assert route.outputConcepts == ["social_image", "generated_video", "generated_music"]


def test_direct_media_request_remains_deterministic_across_a_conversation():
    route = deterministic_intent_classification(IntentRoutingInput(
        message="Make an image, video, and music for the launch.",
        workspaceContext=context(), attachmentCount=0,
        recentConversation=[{"role": "user", "text": "We are preparing the launch."}],
    ))
    assert route is not None
    assert route.outputConcepts == ["social_image", "generated_video", "generated_music"]


def strategy_context():
    return {
        "company": "Harmonia",
        "product": "An autonomous content engine for startups",
        "positioning": "Turn source material into an evidence-backed content program",
        "differentiators": ["Human approval before external effects"],
        "brandVoice": ["clear", "evidence-led"],
        "exclusions": [],
        "safetyConstraints": ["Do not invent source claims"],
        "businessObjectives": ["Build awareness with startup founders"],
        "campaignObjectives": ["Create a month of useful founder content"],
        "audiences": [{"id": "startup-founders", "name": "Startup founders", "pains": ["Limited time for consistent content"]}],
        "funnelStage": "awareness",
        "intendedConversion": "Visit the website to learn more",
        "requestedChannels": ["linkedin"],
        "supportedChannels": ["linkedin"],
        "horizonWeeks": 4,
    }


def test_route_contract_accepts_normal_user_language_without_internal_tags():
    route = IntentRoute.model_validate({
        "intent": "one_off_content",
        "userOutcome": "Announce the launch to founders",
        "sourceUrls": [],
        "outputConcepts": ["short_social_post", "professional_post"],
        "platformRecommendations": ["x", "linkedin"],
        "connectionSuggestions": ["linkedin"],
        "assumptions": ["Use the approved workspace voice."],
        "needsClarification": False,
        "clarifyingQuestion": None,
        "requiresRightsAttestation": False,
        "effectRequested": False,
        "jobId": None,
        "strategyContext": None,
    })
    assert route.intent == "one_off_content"
    assert "x_post" not in route.model_dump_json()


def test_source_route_requires_strategy_context_before_starting_a_job():
    with pytest.raises(ValidationError, match="strategy context"):
        IntentRoute.model_validate({
            "intent": "establish_strategy",
            "userOutcome": "Help more startup founders discover us",
            "sourceUrls": ["https://example.com"],
            "outputConcepts": ["professional_post"],
            "platformRecommendations": ["linkedin"],
            "connectionSuggestions": [],
            "assumptions": ["Awareness is the initial funnel objective."],
            "needsClarification": False,
            "clarifyingQuestion": None,
            "requiresRightsAttestation": False,
            "effectRequested": False,
            "jobId": None,
        })


def test_source_route_carries_typed_strategy_context_from_ordinary_conversation():
    route = IntentRoute.model_validate({
        "intent": "establish_strategy",
        "userOutcome": "Help more startup founders discover us",
        "sourceUrls": ["https://example.com"],
        "outputConcepts": ["professional_post"],
        "platformRecommendations": ["linkedin"],
        "connectionSuggestions": [],
        "assumptions": ["Awareness is the initial funnel objective."],
        "needsClarification": False,
        "clarifyingQuestion": None,
        "requiresRightsAttestation": False,
        "effectRequested": False,
        "effectAuthorized": False,
        "jobId": None,
        "strategyContext": strategy_context(),
    })
    assert route.strategyContext.product == "An autonomous content engine for startups"
    assert route.strategyContext.horizonWeeks == 4


def test_route_contract_cannot_authorize_an_external_effect():
    with pytest.raises(ValidationError, match="cannot authorize"):
        IntentRoute.model_validate({
            "intent": "effect_request",
            "userOutcome": "Publish the approved launch post",
            "sourceUrls": [],
            "outputConcepts": ["short_social_post"],
            "platformRecommendations": ["x"],
            "connectionSuggestions": [],
            "assumptions": [],
            "needsClarification": False,
            "clarifyingQuestion": None,
            "requiresRightsAttestation": False,
            "effectRequested": True,
            "effectAuthorized": True,
            "jobId": None,
            "strategyContext": None,
        })


@pytest.mark.parametrize("outcome", [
    "Harmonia has accepted the source and prepared the strategy.",
    "The source was successfully repurposed into platform-native posts.",
])
def test_route_outcome_cannot_claim_work_completed_before_the_job_runs(outcome):
    with pytest.raises(ValidationError, match="desired future outcome"):
        IntentRoute.model_validate({
            "intent": "repurpose_source",
            "userOutcome": outcome,
            "sourceUrls": ["https://harmonia.example/source"],
            "outputConcepts": ["professional_post"],
            "platformRecommendations": ["linkedin"],
            "connectionSuggestions": [],
            "assumptions": [],
            "needsClarification": False,
            "clarifyingQuestion": None,
            "requiresRightsAttestation": True,
            "effectRequested": False,
            "effectAuthorized": False,
            "jobId": None,
            "strategyContext": None,
        })


def test_routing_input_is_bounded_and_workspace_context_is_typed():
    payload = IntentRoutingInput.model_validate({
        "message": "Plan next month's founder content from our current strategy",
        "workspaceContext": context(strategyReady=True, goals=["Increase qualified trials"]),
        "attachmentCount": 0,
    })
    assert payload.workspaceContext.strategyReady is True
    assert payload.workspaceContext.goals == ["Increase qualified trials"]


def test_recent_job_summary_allows_a_2000_character_evidence_summary():
    payload = IntentRoutingInput.model_validate({
        "message": "What should we do next?",
        "workspaceContext": context(recentJobs=[{
            "id": "job-1", "stage": "strategize", "status": "running", "title": "x" * 2_000,
        }]),
        "attachmentCount": 0,
    })
    assert len(payload.workspaceContext.recentJobs[0].title or "") == 2_000


def test_source_urls_require_current_message_or_explicit_pending_authority():
    payload = IntentRoutingInput.model_validate({
        "message": "Please try again.",
        "workspaceContext": context(),
        "attachmentCount": 0,
        "recentConversation": [
            {"role": "user", "text": "Use https://harmonia.example/demo, please."},
            {"role": "assistant", "text": "I will use the supplied source."},
        ],
    })
    assert source_urls_from_input(payload) == []
    payload.pendingSourceUrls = ["https://harmonia.example/demo"]
    assert source_urls_from_input(payload) == ["https://harmonia.example/demo"]


def test_harmonia_routing_skill_is_loadable():
    from harmonia_agent.agents import build_agent_team
    specialist = build_agent_team().find_sub_agent("harmonia_intent_router")
    assert specialist.tools == []
    assert "skill" in specialist.instruction.lower()
    assert specialist.input_schema is not None



def test_connection_tool_reports_real_safe_platform_state(monkeypatch):
    from harmonia_agent import intent_routing
    monkeypatch.setattr(intent_routing.web_client, "get_platform_connections", lambda: [
        {"id": "x", "label": "X", "connected": True, "health": "healthy"},
        {"id": "linkedin", "label": "LinkedIn", "connected": False, "health": "not_connected"},
        {"id": "google-drive", "label": "Drive", "connected": True, "health": "healthy"},
    ])
    result = intent_routing.get_social_platform_connections()
    assert result["status"] == "success"
    assert [item["id"] for item in result["data"]["platforms"]] == ["x", "linkedin"]
    assert "token" not in str(result).lower()
