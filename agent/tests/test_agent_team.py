"""ADK team topology, contracts, and offline delegation behavior."""

from __future__ import annotations

import asyncio

import pytest
from pydantic import ValidationError

from google.adk.agents import LoopAgent, SequentialAgent
from google.adk.models._capabilities import LlmCapabilities
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.tools.agent_tool import AgentTool
from google.genai import types

from harmonia_agent.agent_models import (
    AnalysisResult,
    AnalystInput,
    ContentDraft,
    CopywriterInput,
    EditorialPlan,
    EditorialPlannerInput,
    LiaisonInput,
    MediaEvidence,
    StrategistInput,
    StrategistResult,
)
from harmonia_agent.agents import (
    AgentProtocolError,
    _reservation_payloads,
    _resolve_role_models,
    _run_coordinator,
    _validate_run_output,
    _validate_strategy_result,
    _validated_state,
    analyze_with_team,
    build_agent_team,
    draft_with_team,
    plan_with_team,
    strategize_with_team,
    RoleModelInstances,
)
from harmonia_agent.tenant_context import tenant_scope
from harmonia_agent.generation_policy import safety_settings
from harmonia_agent.usage import InvocationContext
from tests.test_ryan_strategy import strategy as _content_strategy


def _temi_plan():
    from tests.test_temi_editorial_plan import plan

    return plan()


def _planner_input():
    from tests.test_temi_editorial_plan import planner_input

    return planner_input()


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
                '{"summary":"Delegated analysis","moments":[],"angles":[]}'
            ))]))
            return
        if llm_request.tools_dict and not function_responses:
            self.calls.append("coordinator")
            yield LlmResponse(content=types.Content(role="model", parts=[types.Part(
                function_call=types.FunctionCall(
                    name="nimi_analyst",
                    args={
                        "title": "Demo", "channel": "Harmonia",
                        "transcript": "[0s] hello [30s] proof", "prior_learnings": "",
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


def _analysis() -> AnalysisResult:
    return AnalysisResult.model_validate({
        "summary": "A useful startup lesson.",
        "moments": [{
            "id": "m1", "title": "Activation", "startSec": 1,
            "endSec": 8, "hook": "Cut the delay", "quote": "We cut nine days to forty hours.",
        }],
        "angles": [{
            "id": "a1", "kind": "trend", "title": "Speed wins",
            "rationale": "Founders care about activation.",
        }],
    })


def _editorial_plan() -> EditorialPlan:
    return EditorialPlan.model_validate(_temi_plan())


def _production_input() -> ProductionDraftInput:
    strategy = _content_strategy()
    item = _editorial_plan().items[0]
    return ProductionDraftInput(
        planId="plan-job-1-v1", strategyDigest="a" * 64, editorialItem=item,
        brief=strategy.briefs[0], referencedMoments=_analysis().moments,
        referencedAngles=[], brandContext="voice: direct",
        constraints=item.constraints,
    )


class ManagedRuntime:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def invoke(self, **kwargs):
        self.calls.append(kwargs)
        if kwargs["specialist"] == "nimi_analyst":
            return {"analysis_result": {
                **_analysis().model_dump(mode="json"),
                "summary": "Delegated analysis",
            }}
        if kwargs["specialist"] == "temi_editorial_planner":
            return {"editorial_plan": _temi_plan()}
        return {
            "copywriter_drafts": {"drafts": [
                {"id": "d1", "platform": "x", "momentId": "m1", "text": "Original"},
            ]},
            "reviewed_drafts": {"drafts": [
                {"id": "d1", "platform": "x", "momentId": "m1", "text": "Reviewed"},
            ]},
            "action_plan": {"actions": [
                {"type": "publish_x_post", "text": "Reviewed"},
            ]},
        }


def test_agent_team_exposes_specialists_and_ordered_draft_workflow():
    root = build_agent_team()

    assert root.name == "harmonia_coordinator"
    assert [(a.name, a.mode) for a in root.sub_agents] == [
        ("ryan_strategist", "single_turn"),
        ("nimi_analyst", "single_turn"),
        ("temi_editorial_planner", "single_turn"),
        ("maya_presenter", "single_turn"),
        ("nova_liaison", "chat"),
    ]
    workflow_tools = [
        t for t in root.tools
        if isinstance(t, AgentTool) and t.name == "flo_content_engine"
    ]
    assert len(workflow_tools) == 1
    workflow = workflow_tools[0].agent
    assert isinstance(workflow, SequentialAgent)
    assert [a.name for a in workflow.sub_agents] == ["noni_dara_revision_loop"]
    loop = workflow.sub_agents[0]
    assert isinstance(loop, LoopAgent)
    assert loop.max_iterations == 2
    assert [a.name for a in loop.sub_agents] == ["noni_copywriter", "dara_editor"]


def test_noni_is_a_focused_tool_free_typed_specialist():
    root = build_agent_team()
    workflow = next(tool.agent for tool in root.tools if tool.name == "flo_content_engine")
    noni = workflow.sub_agents[0].sub_agents[0]

    assert noni.name == "noni_copywriter"
    assert noni.input_schema is CopywriterInput
    assert noni.output_schema is ContentDraft
    assert noni.output_key == "copywriter_draft"
    assert noni.mode == "single_turn"
    assert noni.tools == []


def test_team_assigns_the_configured_model_to_each_role():
    def scripted(name: str) -> ScriptedDraftModel:
        return ScriptedDraftModel(model=name)

    root = build_agent_team(models=RoleModelInstances(
        coordinator=scripted("coordinator-fake"),
        strategist=scripted("strategist-fake"),
        analyst=scripted("analyst-fake"),
        copywriter=scripted("gemma-fake"),
        editor=scripted("editor-fake"),
        planner=scripted("planner-fake"),
        presenter=scripted("presenter-fake"),
        liaison=scripted("liaison-fake"),
    ))

    assert root.model.model == "coordinator-fake"
    assert [agent.model.model for agent in root.sub_agents] == [
        "strategist-fake", "analyst-fake", "planner-fake", "presenter-fake", "liaison-fake",
    ]
    workflow = next(tool.agent for tool in root.tools if tool.name == "flo_content_engine")
    assert [agent.model.model for agent in workflow.sub_agents[0].sub_agents] == ["gemma-fake", "editor-fake"]


def test_team_applies_each_roles_generation_and_safety_policy(monkeypatch):
    monkeypatch.setenv(
        "GEMMA_VERTEX_ENDPOINT",
        "projects/p/locations/us-central1/endpoints/123",
    )
    root = build_agent_team()

    assert root.generate_content_config.temperature == 0.1
    assert root.generate_content_config.max_output_tokens == 1024
    assert len(root.generate_content_config.safety_settings) == 4

    analyst = next(agent for agent in root.sub_agents if agent.name == "nimi_analyst")
    assert analyst.generate_content_config.temperature == 0.2
    assert analyst.generate_content_config.max_output_tokens == 2048

    planner = next(agent for agent in root.sub_agents if agent.name == "temi_editorial_planner")
    workflow = next(tool.agent for tool in root.tools if tool.name == "flo_content_engine")
    revision_loop = workflow.sub_agents[0]
    copywriter, _ = revision_loop.sub_agents
    assert copywriter.generate_content_config.temperature == 0.8
    assert copywriter.generate_content_config.max_output_tokens == 2048
    assert planner.generate_content_config.temperature == 0.1
    assert planner.generate_content_config.max_output_tokens == 1024


def test_unknown_safety_profile_is_rejected():
    with pytest.raises(ValueError, match="unknown safety profile"):
        safety_settings("not-a-policy")


def test_agent_reservations_record_exact_model_policy(monkeypatch):
    monkeypatch.setenv(
        "GEMMA_VERTEX_ENDPOINT",
        "projects/p/locations/us-central1/endpoints/123",
    )
    invocation = InvocationContext(
        workspace_id="w1", brand_id="b1", user_id="u1", job_id="j1",
        stage="understand", operation_id="j1:understand:0",
    )

    reservations = _reservation_payloads(
        "nimi_analyst",
        AnalystInput(title="Synthetic", transcript="[0s] public evidence"),
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
        "eligibleTasks": ["analyze_media", "analyze_transcript"],
        "minimumPassRate": "0.95",
    }


def test_coordinator_really_delegates_and_forwards_specialist_state():
    runtime = ManagedRuntime()
    with tenant_scope("workspace-test", "brand-test"):
        state = asyncio.run(_run_coordinator(
            "nimi_analyst",
            AnalystInput(title="Demo", channel="Harmonia", transcript="[0s] hello [30s] proof"),
            model="gemini-test",
            team_runtime=runtime,
        ))

    result = _validated_state(state, "analysis_result", AnalysisResult)
    assert result.summary == "Delegated analysis"
    assert runtime.calls[0]["specialist"] == "nimi_analyst"
    assert runtime.calls[0]["user_id"] == "workspace-test:system:proactive"


def test_analyst_receives_source_video_as_a_real_multimodal_part():
    runtime = ManagedRuntime()
    source = "https://www.youtube.com/watch?v=abc12345678"

    with tenant_scope("workspace-test", "brand-test"):
        asyncio.run(_run_coordinator(
            "nimi_analyst",
            AnalystInput(
                title="Demo",
                channel="Harmonia",
                transcript="[0s] hello [30s] proof",
                media_evidence=MediaEvidence(
                    video_uri=source,
                    duration_sec=60,
                    source_digest="a" * 64,
                ),
            ),
            model="gemini-test",
            team_runtime=runtime,
        ))

    assert runtime.calls[0]["payload"]["media_evidence"]["video_uri"] == source


def test_draft_agent_tool_forwards_all_sequential_state_to_coordinator():
    runtime = ManagedRuntime()
    input = _production_input()
    with tenant_scope("workspace-test", "brand-test"):
        state = asyncio.run(_run_coordinator(
            "flo_content_engine", input, model="gemini-test", team_runtime=runtime,
        ))

    assert _validated_state(state, "reviewed_drafts", DraftSet).drafts[0].text == "Reviewed"
    assert runtime.calls[0]["specialist"] == "flo_content_engine"


def test_temi_runs_as_a_distinct_tool_free_typed_specialist():
    root = build_agent_team()
    planner = next(agent for agent in root.sub_agents if agent.name == "temi_editorial_planner")

    assert planner.input_schema is EditorialPlannerInput
    assert planner.output_schema is EditorialPlan
    assert planner.tools == []
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
        _validated_state({}, "analysis_result", AnalysisResult)
    assert classify_failure(AgentProtocolError("bad structured output")) is True
    with pytest.raises(ValidationError) as invalid:
        Draft(id="d1", platform="x", text="x" * 281)
    assert classify_failure(invalid.value) is True


def test_liaison_must_return_nonempty_answer_text():
    with pytest.raises(AgentProtocolError, match="no answer text"):
        _validate_run_output("nova_liaison", LiaisonInput(question="what is pending?"), {})
    with pytest.raises(AgentProtocolError, match="no answer text"):
        _validate_run_output("nova_liaison", LiaisonInput(question="q"), {"liaison_answer": "   "})
    _validate_run_output(
        "nova_liaison",
        LiaisonInput(question="q"),
        {"liaison_answer": "Two jobs await approval."},
    )


def test_draft_workflow_result_requires_editor_to_preserve_identity_and_references():
    original = DraftSet(drafts=[Draft(
        id="d1", platform="x", momentId="m1", text="Original draft",
    )])

    with pytest.raises(ValidationError, match="preserve draft id"):
        DraftWorkflowResult(
            copywriter_drafts=original,
            reviewed_drafts=DraftSet(drafts=[Draft(
                id="changed", platform="x", momentId="m1", text="Revised draft",
            )]),
            action_plan=ActionPlan(actions=[]),
        )

    with pytest.raises(ValidationError, match="preserve source references"):
        DraftWorkflowResult(
            copywriter_drafts=original,
            reviewed_drafts=DraftSet(drafts=[Draft(
                id="d1", platform="x", angleId="a1", text="Revised draft",
            )]),
            action_plan=ActionPlan(actions=[]),
        )


def test_draft_workflow_result_limits_actions_to_reviewed_drafts():
    original = DraftSet(drafts=[Draft(id="d1", platform="x", text="Original")])
    reviewed = DraftSet(drafts=[Draft(id="d1", platform="x", text="Reviewed")])

    with pytest.raises(ValidationError, match="reviewed draft text"):
        DraftWorkflowResult(
            copywriter_drafts=original,
            reviewed_drafts=reviewed,
            action_plan=ActionPlan(actions=[PublishAction(text="Original")]),
        )


def test_temi_run_output_rejects_an_unknown_brief():
    supplied = EditorialPlannerInput.model_validate(_planner_input())
    invalid = _temi_plan()
    invalid["items"][0]["briefId"] = "brief-invented"
    with pytest.raises(AgentProtocolError, match="unknown brief"):
        _validate_run_output(
            "temi_editorial_planner", supplied, {"editorial_plan": invalid},
        )


def test_mock_team_routes_all_roles_and_returns_validated_shapes(monkeypatch, capsys):
    monkeypatch.setenv("HARMONIA_MOCK_AI", "1")
    analysis = asyncio.run(analyze_with_team(AnalystInput(
        title="Demo", channel="Harmonia", transcript="[0s] hello [30s] proof",
    )))
    assert analysis.summary
    with pytest.raises(RuntimeError, match="no mock editorial-plan path"):
        asyncio.run(plan_with_team(EditorialPlannerInput.model_validate(_planner_input())))
    trace = capsys.readouterr().out
    assert "[MOCK-AI] coordinator -> nimi_analyst" in trace
