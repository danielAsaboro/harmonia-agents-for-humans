"""Harmonia's typed Google ADK coordinator and specialist workflows."""

from __future__ import annotations

import json
import os
from typing import Any, TypeVar

from google.adk.agents import Agent, SequentialAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools.agent_tool import AgentTool
from google.genai import types
from pydantic import BaseModel, ValidationError

from .agent_models import (
    ActionPlan,
    AnalysisResult,
    AnalystInput,
    DraftSet,
    DraftWorkflowInput,
    DraftWorkflowResult,
    StrategistInput,
    StrategistResult,
    validate_draft_references,
)
from .config import settings
from .mock_ai import (
    mock_ai_enabled,
    mock_analyze,
    mock_drafts,
    mock_ideate,
    mock_plan_actions,
    mock_propose_gap_fillers,
    mock_propose_ideas,
    mock_propose_recycle,
)

T = TypeVar("T", bound=BaseModel)


class AgentProtocolError(RuntimeError):
    """The agent team returned missing or contract-invalid structured output."""


def _model(model: str | BaseLlm | None = None) -> str | BaseLlm:
    cfg = settings()
    if cfg.gemini_api_key:
        os.environ.setdefault("GOOGLE_API_KEY", cfg.gemini_api_key)
    return model or cfg.model_id


def build_agent_team(model: str | BaseLlm | None = None) -> Agent:
    """Build one coordinator with two delegated specialists and one draft workflow."""
    llm = _model(model)
    strategist = Agent(
        model=llm,
        name="ryan_strategist",
        description=(
            "Develops startup content strategy from briefs, trend signals, calendar gaps, "
            "past learnings, and proven posts."
        ),
        instruction=(
            "Complete exactly the requested strategy task. For task=brief, return analysis with "
            "a summary, 3-6 key-point moments using zero timestamps, and trend/meme angles. For "
            "other tasks return 1-3 timely ideas grounded only in the supplied evidence. Return "
            "only the StrategistResult JSON contract."
        ),
        input_schema=StrategistInput,
        output_schema=StrategistResult,
        output_key="strategist_result",
        mode="single_turn",
    )
    analyst = Agent(
        model=llm,
        name="sophia_analyst",
        description="Finds clip-worthy moments and defensible trend or meme angles in a transcript.",
        instruction=(
            "Analyze only the supplied video metadata, transcript, and learnings. Return a concise "
            "summary, 3-6 timestamp-bounded moments with exact quotes, and useful trend/meme "
            "angles. Return only the AnalysisResult JSON contract."
        ),
        input_schema=AnalystInput,
        output_schema=AnalysisResult,
        output_key="analysis_result",
        mode="single_turn",
    )
    copywriter = Agent(
        model=llm,
        name="nimi_copywriter",
        description="Writes platform-native X drafts grounded in supplied moments and angles.",
        instruction=(
            "Write up to 10 punchy X posts for a startup audience. Every draft must be at most 280 "
            "characters and may reference only a supplied momentId or angleId. Preserve useful "
            "brand context. Return only the DraftSet JSON contract."
        ),
        input_schema=DraftWorkflowInput,
        output_schema=DraftSet,
        output_key="copywriter_drafts",
    )
    editor = Agent(
        model=llm,
        name="dara_editor",
        description="Performs one editorial revision pass against brand voice and source grounding.",
        instruction=(
            "Edit {copywriter_drafts} against the analysis and brand context already in session "
            "state. Return the final DraftSet after one revision pass. You may revise or omit drafts, "
            "but must preserve each retained draft id, platform, momentId, and angleId. Never add a "
            "new draft. Keep every text at most 280 characters."
        ),
        output_schema=DraftSet,
        output_key="reviewed_drafts",
    )
    planner = Agent(
        model=llm,
        name="temi_planner",
        description="Selects reviewed X drafts for operator-approved publishing actions.",
        instruction=(
            "Read {reviewed_drafts}. Propose publish_x_post actions only for exact reviewed draft "
            "text. Do not create, revise, delete, approve, or publish content. Return only the "
            "ActionPlan JSON contract."
        ),
        output_schema=ActionPlan,
        output_key="action_plan",
    )
    draft_workflow = SequentialAgent(
        name="flo_draft_workflow",
        description="Runs copywriting, one editor revision, then safe action planning in fixed order.",
        sub_agents=[copywriter, editor, planner],
    )
    return Agent(
        model=llm,
        name="harmonia_coordinator",
        description="Routes Harmonia judgment tasks to typed specialists; never performs external effects.",
        instruction=(
            "Delegate exactly once to the specialist named in the user's task instruction. Use "
            "ryan_strategist for strategy, sophia_analyst for transcript analysis, and "
            "flo_draft_workflow for the ordered draft-edit-plan workflow. Never answer the task "
            "yourself and never call "
            "publishing or approval systems."
        ),
        sub_agents=[strategist, analyst],
        tools=[AgentTool(draft_workflow)],
    )


def _validated_state(state: dict[str, Any], key: str, schema: type[T]) -> T:
    if key not in state:
        raise AgentProtocolError(f"coordinator did not produce required state key: {key}")
    value = state[key]
    try:
        return schema.model_validate_json(value) if isinstance(value, str) else schema.model_validate(value)
    except (ValidationError, ValueError, TypeError) as exc:
        raise AgentProtocolError(f"invalid agent output for {key}: {exc}") from exc


async def _run_coordinator(
    specialist: str,
    payload: BaseModel,
    *,
    model: str | BaseLlm | None = None,
) -> dict[str, Any]:
    service = InMemorySessionService()
    root = build_agent_team(model)
    runner = Runner(agent=root, app_name="harmonia", session_service=service)
    state = payload.model_dump(mode="json")
    state["requested_specialist"] = specialist
    session = await service.create_session(app_name="harmonia", user_id="system", state=state)
    prompt = (
        f"Delegate this request to {specialist} exactly once. Pass this JSON unchanged:\n"
        f"{payload.model_dump_json(exclude_none=True)}"
    )
    try:
        try:
            async for _event in runner.run_async(
                user_id="system",
                session_id=session.id,
                new_message=types.Content(role="user", parts=[types.Part(text=prompt)]),
            ):
                pass
        except (ValidationError, ValueError, json.JSONDecodeError) as exc:
            raise AgentProtocolError(f"agent delegation or structured output failed: {exc}") from exc
        completed = await service.get_session(
            app_name="harmonia", user_id="system", session_id=session.id,
        )
        if completed is None:
            raise AgentProtocolError("coordinator session disappeared before output validation")
        return dict(completed.state)
    finally:
        await runner.close()


async def analyze_with_team(input: AnalystInput) -> AnalysisResult:
    input = AnalystInput.model_validate(input)
    if mock_ai_enabled():
        print("[MOCK-AI] coordinator -> sophia_analyst", flush=True)
        raw = mock_analyze(input.title, input.channel, input.transcript, input.prior_learnings)
        return AnalysisResult.model_validate({k: v for k, v in raw.items() if k != "mock"})
    state = await _run_coordinator("sophia_analyst", input)
    return _validated_state(state, "analysis_result", AnalysisResult)


def _validate_strategy_result(
    input: StrategistInput,
    result: StrategistResult,
) -> StrategistResult:
    if input.task == "brief" and result.analysis is None:
        raise AgentProtocolError("strategist brief task must return analysis")
    if input.task != "brief" and not result.ideas:
        raise AgentProtocolError(f"strategist {input.task} task must return ideas")
    return result


async def strategize_with_team(input: StrategistInput) -> StrategistResult:
    input = StrategistInput.model_validate(input)
    if mock_ai_enabled():
        print("[MOCK-AI] coordinator -> ryan_strategist", flush=True)
        if input.task == "brief":
            raw = mock_ideate(input.brief, input.prior_learnings)
            result = {"analysis": {k: v for k, v in raw.items() if k != "mock"}}
        elif input.task == "trend_scan":
            result = mock_propose_ideas(input.signals)
        elif input.task == "calendar_gap":
            result = mock_propose_gap_fillers(input.goals_text, input.learnings_text)
        else:
            result = mock_propose_recycle(input.post_text, input.likes)
        return _validate_strategy_result(input, StrategistResult.model_validate(result))
    state = await _run_coordinator("ryan_strategist", input)
    result = _validated_state(state, "strategist_result", StrategistResult)
    return _validate_strategy_result(input, result)


async def draft_with_team(input: DraftWorkflowInput) -> DraftWorkflowResult:
    input = DraftWorkflowInput.model_validate(input)
    if mock_ai_enabled():
        print("[MOCK-AI] coordinator -> nimi_copywriter", flush=True)
        copywriter = DraftSet.model_validate({"drafts": mock_drafts(
            input.title, input.analysis.model_dump(mode="json"),
        )})
        validate_draft_references(copywriter, input.analysis)
        print("[MOCK-AI] coordinator -> dara_editor", flush=True)
        reviewed = DraftSet.model_validate(copywriter.model_dump(mode="json"))
        print("[MOCK-AI] coordinator -> temi_planner", flush=True)
        raw_plan = mock_plan_actions(reviewed.model_dump(mode="json")["drafts"])
        plan = ActionPlan.model_validate({
            "actions": [a for a in raw_plan["actions"] if a.get("type") == "publish_x_post"],
        })
        return DraftWorkflowResult(
            copywriter_drafts=copywriter, reviewed_drafts=reviewed, action_plan=plan,
        )

    state = await _run_coordinator("flo_draft_workflow", input)
    copywriter = _validated_state(state, "copywriter_drafts", DraftSet)
    reviewed = _validated_state(state, "reviewed_drafts", DraftSet)
    plan = _validated_state(state, "action_plan", ActionPlan)
    try:
        validate_draft_references(copywriter, input.analysis)
        validate_draft_references(reviewed, input.analysis)
        return DraftWorkflowResult(
            copywriter_drafts=copywriter, reviewed_drafts=reviewed, action_plan=plan,
        )
    except (ValidationError, ValueError) as exc:
        raise AgentProtocolError(f"invalid draft workflow result: {exc}") from exc


def strategize_with_team_sync(input: StrategistInput) -> StrategistResult:
    """Run strategist from the proactive worker thread, which has no event loop."""
    import asyncio

    return asyncio.run(strategize_with_team(input))
