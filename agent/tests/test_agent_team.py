"""ADK team topology, contracts, and offline delegation behavior."""

from __future__ import annotations

import asyncio

import pytest
from pydantic import ValidationError

from google.adk.models._capabilities import LlmCapabilities
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.tools.agent_tool import AgentTool
from google.genai import types

from harmonia_agent.agent_models import (
    SourceAnalysis,
    AnalystInput,
    ContentDraft,
    CopywriterInput,
    EditorialAssessment,
    EditorialPlan,
    EditorialPlannerInput,
    EditorialReview,
    LiaisonInput,
    StrategistInput,
    StrategistResult,
)
from harmonia_agent.content_artifacts import ArtifactProductionInput, ArtifactReviewBatch, ProductionBatch
from harmonia_agent.agents import (
    AgentProtocolError,
    _enforce_requested_specialist_transfer,
    _reservation_payloads,
    _resolve_role_models,
    _run_coordinator,
    _validate_run_output,
    _validate_strategy_result,
    _validated_state,
    analyze_with_team,
    build_agent_team,
    plan_with_team,
    strategize_with_team,
    RoleModelInstances,
)
from harmonia_agent.agent_errors import AgentContractError
from harmonia_agent.stages import classify_failure
from harmonia_agent.tenant_context import tenant_scope
from harmonia_agent.generation_policy import safety_settings
from harmonia_agent.usage import InvocationContext


def _temi_plan():
    from tests.test_temi_editorial_plan import plan

    return plan()


def _planner_input():
    from tests.test_temi_editorial_plan import planner_input

    return planner_input()


def _analyst_input(**updates) -> AnalystInput:
    value = {
        "sourceIds": ["source-1"], "sourceKind": "video", "sourceDigest": "a" * 64,
        "title": "Demo",
        "sourceSegments": [{"id": "segment-1", "sourceId": "source-1", "text": "hello proof We cut nine days to forty hours.", "digest": "b" * 64, "locator": {"kind": "time_range", "startMs": 0, "endMs": 30_000}}],
        "performanceObservations": [], "memoryFacts": [],
    }
    value.update(updates)
    return AnalystInput.model_validate(value)


class ScriptedDelegationModel(BaseLlm):
    calls: list[str] = []
    media_uris: list[str] = []

    @property
    def capabilities(self) -> LlmCapabilities:
        return LlmCapabilities(output_schema_and_tools=True)

    async def generate_content_async(self, llm_request, stream=False):
        function_responses = [
            part.function_response
            for content in llm_request.contents
            for part in (content.parts or [])
            if part.function_response
        ]
        if llm_request.config.response_schema is not None:
            self.calls.append("nimi_analyst")
            self.media_uris.extend(
                part.file_data.file_uri
                for content in llm_request.contents
                for part in (content.parts or [])
                if part.file_data is not None
            )
            yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text=(
                '{"sourceDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","summary":"Delegated analysis","moments":[{"id":"m1","title":"Proof","startSec":0,"endSec":30,"hook":"hello","quote":"hello","sourceSegmentRefs":["segment-1"],"visualEvidenceIds":[],"assumptions":[],"confidence":"high"}],"angles":[{"id":"a1","angleType":"source_insight","evidenceKind":"source","title":"Source proof","rationale":"The source contains proof.","evidenceRefs":["m1"],"assumptions":[],"confidence":"high"}],"assumptions":[],"confidence":"high"}'
            ))]))
            return
        if llm_request.tools_dict and not function_responses:
            self.calls.append("coordinator")
            yield LlmResponse(content=types.Content(role="model", parts=[types.Part(
                function_call=types.FunctionCall(
                    name="nimi_analyst",
                    args={
                        "sourceIds": ["source-1"], "sourceKind": "video",
                        "sourceDigest": "a" * 64, "title": "Demo",
                        "sourceSegments": [{"id": "segment-1", "sourceId": "source-1", "text": "hello proof We cut nine days to forty hours.", "digest": "b" * 64, "locator": {"kind": "time_range", "startMs": 0, "endMs": 30000}}],
                        "performanceObservations": [], "memoryFacts": [],
                    },
                ),
            )]))
            return
        self.calls.append("coordinator_return")
        yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text="done")]))


class ScriptedDraftModel(BaseLlm):
    calls: list[str] = []

    @property
    def capabilities(self) -> LlmCapabilities:
        return LlmCapabilities(output_schema_and_tools=True)

    async def generate_content_async(self, llm_request, stream=False):
        instructions = str(llm_request.config.system_instruction)
        function_responses = [
            part.function_response
            for content in llm_request.contents
            for part in (content.parts or [])
            if part.function_response
        ]
        if llm_request.config.response_schema is not None:
            response_schema = str(llm_request.config.response_schema)
            if "strategySummary" in response_schema or "editorial plan" in instructions:
                self.calls.append("temi_editorial_planner")
                text = '{"strategySummary":"Activation lessons","items":[{"id":"c1","briefId":"brief-1","platform":"x","objective":"Teach activation speed","sourceRef":"m1","format":"text_post","priority":1}]}'
            elif "Write up to 10" in instructions:
                self.calls.append("noni_copywriter")
                text = '{"drafts":[{"id":"d1","platform":"x","momentId":"m1","text":"Original"}]}'
            else:
                self.calls.append("dara_editor")
                text = '{"drafts":[{"id":"d1","platform":"x","momentId":"m1","text":"Reviewed"}]}'
            yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text=text)]))
            return
        if llm_request.tools_dict and not function_responses:
            self.calls.append("coordinator")
            yield LlmResponse(content=types.Content(role="model", parts=[types.Part(
                function_call=types.FunctionCall(
                    name="flo_content_engine",
                    args={
                        "title": "Demo",
                        "analysis": _analysis().model_dump(mode="json"),
                        "brand_context": "voice: direct",
                    },
                ),
            )]))
            return
        self.calls.append("coordinator_return")
        yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text="done")]))


def _analysis() -> SourceAnalysis:
    return SourceAnalysis.model_validate({
        "sourceDigest": "a" * 64,
        "summary": "A useful startup lesson.",
        "moments": [{
            "id": "m1", "title": "Activation", "startSec": 1,
            "endSec": 8, "hook": "Cut the delay", "quote": "We cut nine days to forty hours.",
            "sourceSegmentRefs": ["segment-1"], "visualEvidenceIds": [],
            "assumptions": [], "confidence": "high",
        }],
        "angles": [{
            "id": "a1", "angleType": "source_insight", "evidenceKind": "source", "title": "Speed wins",
            "rationale": "The source describes activation speed.",
            "evidenceRefs": ["m1"], "assumptions": [], "confidence": "high",
        }],
        "assumptions": [], "confidence": "high",
    })


def _production_input() -> CopywriterInput:
    from tests.test_noni_contracts import original_input
    return CopywriterInput.model_validate(original_input())


class ManagedRuntime:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def invoke(self, **kwargs):
        self.calls.append(kwargs)
        if kwargs["specialist"] == "nimi_analyst":
            return {
                "source_analysis": {
                    **_analysis().model_dump(mode="json"),
                    "summary": "Delegated analysis",
                },
                "nimi_analysis_skill_trace": [
                    {"sequence": 1, "name": "load_skill", "args": {
                        "skill_name": "nimi-analysis-skills",
                    }},
                    {"sequence": 2, "name": "load_skill_resource", "args": {
                        "skill_name": "nimi-analysis-skills",
                        "file_path": "references/evidence-observation-and-provenance.md",
                    }},
                ],
                "nimi_analysis_research_trace": [],
            }
        if kwargs["specialist"] == "temi_editorial_planner":
            snapshot_id = kwargs["payload"]["planningSnapshot"]["snapshotId"]
            return {
                "editorial_plan": _temi_plan(),
                "temi_editorial_planning_trace": [
                    {"sequence": 1, "name": "load_skill", "args": {"skill_name": "temi-editorial-planning-skills"}},
                    {"sequence": 2, "name": "load_skill_resource", "args": {
                        "skill_name": "temi-editorial-planning-skills",
                        "file_path": "references/strategy-to-editorial-plan.md",
                    }},
                    {"sequence": 3, "name": "read_editorial_commitments", "args": {
                        "snapshot_id": snapshot_id,
                    }, "response": {"snapshotId": snapshot_id, "commitments": []}},
                ],
            }
        from tests.test_noni_contracts import editorial_checks, grounded_draft
        payload = kwargs["payload"]
        if kwargs["specialist"] == "noni_copywriter":
            draft = grounded_draft()
            for field in ("planId", "planDigest", "strategyDigest", "editorialItemId", "briefId"):
                draft[field] = payload[field]
            draft["audienceId"] = payload["brief"]["audienceId"]
            draft["objective"] = payload["brief"]["objective"]
            draft["funnelStage"] = payload["brief"]["funnelStage"]
            draft["ctaIntent"] = payload["brief"]["ctaIntent"]
            return {
                "copywriter_draft": draft,
                "noni_writing_skill_trace": [
                    {"sequence": 1, "name": "load_skill", "args": {"skill_name": "noni-writing-skills"}},
                    {"sequence": 2, "name": "load_skill_resource", "args": {
                        "skill_name": "noni-writing-skills",
                        "file_path": "references/hooks-and-introductions.md",
                    }},
                ],
            }
        if kwargs["specialist"] == "dara_editor":
            return {
                "editorial_assessment": {
                    "verdict": "accepted", "checks": editorial_checks(),
                    "issues": [], "resolvedIssueIds": [],
                },
                "dara_editing_skill_trace": [
                    {"sequence": 1, "name": "load_skill", "args": {
                        "skill_name": "dara-editing-skills",
                    }},
                    {"sequence": 2, "name": "load_skill_resource", "args": {
                        "skill_name": "dara-editing-skills",
                        "file_path": "references/editorial-triage.md",
                    }},
                ],
            }
        raise AssertionError(kwargs["specialist"])


def test_agent_team_exposes_specialists_and_ordered_draft_workflow():
    root = build_agent_team()

    assert root.name == "harmonia_coordinator"
    assert [(a.name, a.mode) for a in root.sub_agents] == [
        ("ryan_strategist", "single_turn"),
        ("nimi_analyst", "single_turn"),
        ("temi_editorial_planner", "single_turn"),
        ("noni_copywriter", "single_turn"),
        ("dara_editor", "single_turn"),
        ("noni_artifact_producer", "single_turn"),
        ("dara_artifact_editor", "single_turn"),
        ("maya_presenter", "single_turn"),
        ("nova_liaison", "chat"),
    ]
    tool_names = {tool.name for tool in root.tools if isinstance(tool, AgentTool)}
    assert "flo_content_engine" not in tool_names
    assert "noni_dara_revision_loop" not in tool_names


def test_noni_is_a_focused_skill_backed_typed_specialist():
    root = build_agent_team()
    noni = next(agent for agent in root.sub_agents if agent.name == "noni_copywriter")

    assert noni.name == "noni_copywriter"
    assert noni.input_schema is CopywriterInput
    assert noni.output_schema is ContentDraft
    assert noni.output_key == "copywriter_draft"
    assert noni.mode == "single_turn"
    assert len(noni.tools) == 2
    assert noni.tools[1].name == "google_search_agent"


def test_multiformat_noni_validated_state_accepts_exact_batch():
    supplied = ArtifactProductionInput.model_validate({"outputPlanId": "plan-1", "outputPlanDigest": "a" * 64, "requests": [{"id": "output-1-newsletter", "outputType": "newsletter", "evidenceRefs": ["source-1:seg-1"]}], "evidence": [{"id": "source-1:seg-1", "text": "Proof"}], "brandContext": "Concise and factual", "constraints": [], "passType": "original", "priorBatch": None, "priorReview": None})
    state = {
        "production_batch": {"artifacts": [{"id": "artifact-1", "outputPlanItemId": "output-1-newsletter", "outputType": "newsletter", "title": "Launch", "sourceSegmentRefs": ["source-1:seg-1"], "payload": {"kind": "newsletter", "subject": "Launch", "preheader": "Proof", "introduction": "Intro", "sections": [{"id": "s1", "heading": "Proof", "body": "Proof", "sourceSegmentRefs": ["source-1:seg-1"]}], "cta": "Try it"}}]},
        "noni_writing_skill_trace": [
            {"sequence": 1, "name": "load_skill", "args": {"skill_name": "noni-writing-skills"}},
            {"sequence": 2, "name": "load_skill_resource", "args": {
                "skill_name": "noni-writing-skills", "file_path": "references/persuasion.md",
            }},
        ],
    }

    _validate_run_output("noni_artifact_producer", supplied, state)
    assert state["_noni_research_evidence"] == {}


def test_dara_is_a_focused_skill_only_review_specialist():
    root = build_agent_team()
    dara = next(agent for agent in root.sub_agents if agent.name == "dara_editor")

    assert dara.output_schema is EditorialAssessment
    assert dara.output_key == "editorial_assessment"
    assert dara.mode == "single_turn"
    assert len(dara.tools) == 1


def test_multiformat_specialists_use_strict_batch_contracts():
    root = build_agent_team()
    noni = next(agent for agent in root.sub_agents if agent.name == "noni_artifact_producer")
    dara = next(agent for agent in root.sub_agents if agent.name == "dara_artifact_editor")
    assert (noni.input_schema, noni.output_schema, noni.output_key) == (ArtifactProductionInput, ProductionBatch, "production_batch")
    assert (dara.output_schema, dara.output_key) == (ArtifactReviewBatch, "artifact_review_batch")


def test_team_assigns_the_configured_model_to_each_role():
    def scripted(name: str) -> ScriptedDraftModel:
        return ScriptedDraftModel(model=name)

    root = build_agent_team(models=RoleModelInstances(
        coordinator=scripted("coordinator-fake"),
        strategist=scripted("strategist-fake"),
        analyst=scripted("analyst-fake"),
        copywriter=scripted("copywriter-fake"),
        editor=scripted("editor-fake"),
        planner=scripted("planner-fake"),
        presenter=scripted("presenter-fake"),
        liaison=scripted("liaison-fake"),
    ))

    assert root.model.model == "coordinator-fake"
    assert [agent.model.model for agent in root.sub_agents] == [
        "strategist-fake", "analyst-fake", "planner-fake", "copywriter-fake",
        "editor-fake", "copywriter-fake", "editor-fake", "presenter-fake", "liaison-fake",
    ]


def test_team_applies_each_roles_generation_and_safety_policy():
    root = build_agent_team()

    assert root.generate_content_config.temperature == 0.1
    assert root.generate_content_config.max_output_tokens == 1024
    assert len(root.generate_content_config.safety_settings) == 4

    analyst = next(agent for agent in root.sub_agents if agent.name == "nimi_analyst")
    assert analyst.generate_content_config.temperature == 0.2
    assert analyst.generate_content_config.max_output_tokens == 2048
    assert len(analyst.tools) == 2
    assert analyst.tools[1].name == "nimi_google_search_agent"

    planner = next(agent for agent in root.sub_agents if agent.name == "temi_editorial_planner")
    copywriter = next(agent for agent in root.sub_agents if agent.name == "noni_copywriter")
    assert copywriter.generate_content_config.temperature == 0.8
    assert copywriter.generate_content_config.max_output_tokens == 2048
    assert planner.generate_content_config.temperature == 0.1
    assert planner.generate_content_config.max_output_tokens == 1024


def test_nimi_private_agent_search_requires_configured_datastore(monkeypatch):
    monkeypatch.setenv(
        "NIMI_AGENT_SEARCH_DATASTORE_ID",
        "projects/project-1/locations/global/collections/default_collection/dataStores/nimi-docs",
    )
    root = build_agent_team()
    analyst = next(agent for agent in root.sub_agents if agent.name == "nimi_analyst")
    assert len(analyst.tools) == 3
    assert [tool.name for tool in analyst.tools[1:]] == [
        "nimi_google_search_agent", "nimi_agent_search_agent",
    ]


def test_unknown_safety_profile_is_rejected():
    with pytest.raises(ValueError, match="unknown safety profile"):
        safety_settings("not-a-policy")


def test_agent_reservations_record_exact_model_policy():
    invocation = InvocationContext(
        workspace_id="w1", brand_id="b1", user_id="u1", job_id="j1",
        stage="understand", operation_id="j1:understand:0",
    )

    reservations = _reservation_payloads(
        "nimi_analyst",
        _analyst_input(title="Synthetic"),
        invocation,
        _resolve_role_models(),
    )

    analyst = next(item for item in reservations if item["role"] == "nimi_analyst")
    assert analyst["modelPolicy"] == {
        "policyVersion": "gear-2026-08-24",
        "pricingVersion": "2026-08-23",
        "temperature": 0.2,
        "topP": 0.9,
        "topK": None,
        "safetyProfile": "harmonia-standard",
        "maxOutputTokens": 2048,
        "timeoutSeconds": 120,
        "eligibleTasks": ["analyze_media", "analyze_sources"],
        "minimumPassRate": "0.95",
    }


def test_coordinator_really_delegates_and_forwards_specialist_state():
    runtime = ManagedRuntime()
    with tenant_scope("workspace-test", "brand-test"):
        state = asyncio.run(_run_coordinator(
            "nimi_analyst",
            _analyst_input(),
            model="gemini-test",
            team_runtime=runtime,
        ))

    result = _validated_state(state, "source_analysis", SourceAnalysis)
    assert result.summary == "Delegated analysis"
    assert runtime.calls[0]["specialist"] == "nimi_analyst"
    assert runtime.calls[0]["user_id"] == "workspace-test:system:proactive"


def test_coordinator_rewrites_model_transfer_to_the_requested_specialist():
    class Tool:
        name = "transfer_to_agent"

    class Context:
        state = {"requested_specialist": "nimi_analyst"}

    args = {"agent_name": "nova_liaison"}

    assert _enforce_requested_specialist_transfer(Tool(), args, Context()) is None
    assert args == {"agent_name": "nimi_analyst"}


def test_analyst_receives_source_video_as_typed_time_range_evidence():
    runtime = ManagedRuntime()
    with tenant_scope("workspace-test", "brand-test"):
        asyncio.run(_run_coordinator(
            "nimi_analyst",
            _analyst_input(),
            model="gemini-test",
            team_runtime=runtime,
        ))

    assert runtime.calls[0]["payload"]["sourceSegments"][0]["locator"] == {"kind": "time_range", "startMs": 0, "endMs": 30_000}


def test_temi_runs_as_a_distinct_skill_backed_typed_specialist():
    root = build_agent_team()
    planner = next(agent for agent in root.sub_agents if agent.name == "temi_editorial_planner")

    assert planner.input_schema is EditorialPlannerInput
    assert planner.output_schema is EditorialPlan
    assert len(planner.tools) == 1
    assert "write final post" in " ".join(planner.instruction.split())


def test_temi_delegation_validates_the_returned_plan():
    runtime = ManagedRuntime()
    supplied = EditorialPlannerInput.model_validate(_planner_input())
    with tenant_scope("workspace-test", "brand-test"):
        state = asyncio.run(_run_coordinator(
            "temi_editorial_planner", supplied, model="gemini-test", team_runtime=runtime,
        ))

    assert _validated_state(state, "editorial_plan", EditorialPlan).planId == "plan-job-1-v1"
    assert runtime.calls[0]["specialist"] == "temi_editorial_planner"


def test_missing_agent_state_is_a_permanent_protocol_failure():
    with pytest.raises(AgentProtocolError, match="required state key"):
        _validated_state({}, "source_analysis", SourceAnalysis)
    assert classify_failure(AgentProtocolError("bad structured output")) is True
    from tests.test_noni_contracts import grounded_draft
    invalid_payload = grounded_draft()
    invalid_payload["text"] = "x" * 281
    with pytest.raises(ValidationError) as invalid:
        ContentDraft.model_validate(invalid_payload)
    assert classify_failure(invalid.value) is True


def test_liaison_must_return_grounded_answer_contract():
    with pytest.raises(AgentContractError, match="Nova returned output"):
        _validate_run_output("nova_liaison", LiaisonInput(question="what is pending?"), {})
    with pytest.raises(AgentContractError, match="Nova returned output"):
        _validate_run_output("nova_liaison", LiaisonInput(question="q"), {"liaison_answer": "   "})
    envelope = {"status": "success", "data": {"found": True}, "error": None,
                "evidence": [{"evidenceId": "ev-aaaaaaaaaaaaaaaa", "source": "harmonia_firestore_job", "provenance": "live"}]}
    _validate_run_output(
        "nova_liaison",
        LiaisonInput(question="q"),
        {"liaison_answer": '{"status":"success","answer":"Job exists [ev-aaaaaaaaaaaaaaaa].","skillName":"job-status","claims":[{"text":"Job exists","evidenceIds":["ev-aaaaaaaaaaaaaaaa"]}],"error":null,"uncertainty":[]}',
         "liaison_tool_trace": [
             {"sequence": 1, "name": "load_skill", "args": {"skill_name": "job-status"}, "response": {}},
             {"sequence": 2, "name": "get_job_status", "args": {"job_id": "job-1"}, "response": envelope},
         ]},
    )


def test_temi_run_output_rejects_an_unknown_brief():
    supplied = EditorialPlannerInput.model_validate(_planner_input())
    invalid = _temi_plan()
    invalid["items"][0]["briefId"] = "brief-invented"
    with pytest.raises(AgentContractError, match="Temi returned output"):
        _validate_run_output(
            "temi_editorial_planner", supplied, {"editorial_plan": invalid},
        )
