"""Harmonia's typed Google ADK coordinator and specialist workflows."""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass, field
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
from .gemma_model import VertexGemmaModel
from .model_catalog import PRICING_VERSION, estimate_text_cost
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
from .multimodal import attach_media_evidence
from .telemetry import current_trace_id, safe_attributes, tracer
from .role_models import RoleModelConfig, load_role_model_catalog
from .usage import (
    InvocationContext,
    UsageAccumulator,
    endpoint_usage_record,
    estimate_request_tokens,
)
from .web_client import report_usage, reserve_budget

T = TypeVar("T", bound=BaseModel)

_SPECIALIST_ROLES = {
    "sophia_analyst": ("harmonia_coordinator", "sophia_analyst"),
    "ryan_strategist": ("harmonia_coordinator", "ryan_strategist"),
    "flo_draft_workflow": (
        "harmonia_coordinator", "nimi_copywriter", "dara_editor", "temi_planner",
    ),
}
_MAX_OUTPUT_TOKENS = {
    "harmonia_coordinator": 1024,
    "sophia_analyst": 2048,
    "ryan_strategist": 2048,
    "nimi_copywriter": 2048,
    "dara_editor": 2048,
    "temi_planner": 1024,
}


class AgentProtocolError(RuntimeError):
    """The agent team returned missing or contract-invalid structured output."""


@dataclass(frozen=True)
class RoleModelInstances:
    coordinator: str | BaseLlm
    strategist: str | BaseLlm
    analyst: str | BaseLlm
    copywriter: str | BaseLlm
    editor: str | BaseLlm
    planner: str | BaseLlm
    configs: dict[str, RoleModelConfig] = field(default_factory=dict)

    def model_for(self, role: str) -> str | BaseLlm:
        mapping = {
            "harmonia_coordinator": self.coordinator,
            "ryan_strategist": self.strategist,
            "sophia_analyst": self.analyst,
            "nimi_copywriter": self.copywriter,
            "dara_editor": self.editor,
            "temi_planner": self.planner,
        }
        try:
            return mapping[role]
        except KeyError as exc:
            raise KeyError(f"unknown agent role: {role}") from exc

    def config_for(self, role: str) -> RoleModelConfig:
        if role in self.configs:
            return self.configs[role]
        return RoleModelConfig(
            role=role,
            provider="gemini",
            model_id=_instance_model_id(self.model_for(role)),
            max_output_tokens=_MAX_OUTPUT_TOKENS[role],
        )


def _model(model: str | BaseLlm | None = None) -> str | BaseLlm:
    cfg = settings()
    if cfg.gemini_api_key:
        os.environ.setdefault("GOOGLE_API_KEY", cfg.gemini_api_key)
    return model or cfg.model_id


def _instance_model_id(model: str | BaseLlm) -> str:
    return model if isinstance(model, str) else model.model


def _resolve_role_models(
    model: str | BaseLlm | None = None,
    models: RoleModelInstances | None = None,
) -> RoleModelInstances:
    if model is not None and models is not None:
        raise ValueError("pass model or models, not both")
    if models is not None:
        return models
    if model is not None:
        shared = _model(model)
        return RoleModelInstances(
            coordinator=shared,
            strategist=shared,
            analyst=shared,
            copywriter=shared,
            editor=shared,
            planner=shared,
        )
    _model(None)  # Preserve Google Gen AI environment initialization.
    catalog = load_role_model_catalog()
    configs = {item.role: item for item in catalog.roles()}
    return RoleModelInstances(
        coordinator=catalog.coordinator.model_id,
        strategist=catalog.strategist.model_id,
        analyst=catalog.analyst.model_id,
        copywriter=VertexGemmaModel(
            model=catalog.copywriter.model_id,
            endpoint=catalog.copywriter.endpoint or "",
        ),
        editor=catalog.editor.model_id,
        planner=catalog.planner.model_id,
        configs=configs,
    )


def _reservation_payloads(
    specialist: str,
    payload: BaseModel,
    invocation: InvocationContext,
    models: RoleModelInstances,
) -> list[dict[str, object]]:
    serialized = payload.model_dump_json(exclude_none=True)
    reservations: list[dict[str, object]] = []
    for role in _SPECIALIST_ROLES[specialist]:
        config = models.config_for(role)
        model_id = _instance_model_id(models.model_for(role))
        estimated_input, estimated_output = estimate_request_tokens(
            serialized * (2 if role == "harmonia_coordinator" else 1),
            config.max_output_tokens,
        )
        estimated_cost = config.reservation_usd or str(estimate_text_cost(
            model_id, estimated_input, estimated_output,
        ))
        reservations.append({
            "jobId": invocation.job_id,
            "operationId": invocation.role_operation_id(role),
            "stage": invocation.stage,
            "role": role,
            "model": model_id,
            "estimatedCostUsd": estimated_cost,
            "pricingVersion": PRICING_VERSION,
        })
    return reservations


def build_agent_team(
    model: str | BaseLlm | None = None,
    *,
    models: RoleModelInstances | None = None,
) -> Agent:
    """Build one coordinator with two delegated specialists and one draft workflow."""
    resolved = _resolve_role_models(model, models)
    strategist = Agent(
        model=resolved.strategist,
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
        model=resolved.analyst,
        name="sophia_analyst",
        description="Finds clip-worthy moments and defensible trend or meme angles in a transcript.",
        instruction=(
            "Analyze only the supplied video/audio parts, metadata, transcript, and learnings. "
            "Use both visible and spoken evidence when media is attached. Return a concise "
            "summary, 3-6 timestamp-bounded moments with exact quotes, and useful trend/meme "
            "angles. Populate visual production fields only from visible evidence and cite only "
            "supplied frame IDs. Return only the AnalysisResult JSON contract."
        ),
        input_schema=AnalystInput,
        output_schema=AnalysisResult,
        output_key="analysis_result",
        mode="single_turn",
        before_model_callback=attach_media_evidence,
    )
    copywriter = Agent(
        model=resolved.copywriter,
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
        model=resolved.editor,
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
        model=resolved.planner,
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
        model=resolved.coordinator,
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
    with tracer().start_as_current_span("harmonia.output.validate") as span:
        span.set_attributes(safe_attributes({
            "output.key": key,
            "schema": schema.__name__,
        }))
        if key not in state:
            raise AgentProtocolError(f"coordinator did not produce required state key: {key}")
        value = state[key]
        try:
            return schema.model_validate_json(value) if isinstance(value, str) else schema.model_validate(value)
        except (ValidationError, ValueError, TypeError) as exc:
            raise AgentProtocolError(f"invalid agent output for {key}: {exc}") from exc


def _validate_run_output(
    specialist: str, payload: BaseModel, state: dict[str, Any],
) -> None:
    if specialist == "sophia_analyst":
        result = _validated_state(state, "analysis_result", AnalysisResult)
        analyst_input = AnalystInput.model_validate(payload)
        valid_visual_ids = {
            frame.id
            for frame in (
                analyst_input.media_evidence.frames
                if analyst_input.media_evidence is not None
                else []
            )
        }
        referenced = {
            visual_id
            for moment in result.moments
            for visual_id in moment.visualEvidenceIds
        }
        invalid = referenced - valid_visual_ids
        if invalid:
            raise AgentProtocolError(
                f"analyst returned unknown visual evidence ids: {sorted(invalid)}"
            )
        return
    if specialist == "ryan_strategist":
        result = _validated_state(state, "strategist_result", StrategistResult)
        _validate_strategy_result(StrategistInput.model_validate(payload), result)
        return
    try:
        copywriter = _validated_state(state, "copywriter_drafts", DraftSet)
        reviewed = _validated_state(state, "reviewed_drafts", DraftSet)
        plan = _validated_state(state, "action_plan", ActionPlan)
        draft_input = DraftWorkflowInput.model_validate(payload)
        validate_draft_references(copywriter, draft_input.analysis)
        validate_draft_references(reviewed, draft_input.analysis)
        DraftWorkflowResult(
            copywriter_drafts=copywriter, reviewed_drafts=reviewed, action_plan=plan,
        )
    except AgentProtocolError:
        raise
    except (ValidationError, ValueError, TypeError) as exc:
        raise AgentProtocolError(f"invalid draft workflow output: {exc}") from exc


async def _run_coordinator(
    specialist: str,
    payload: BaseModel,
    *,
    model: str | BaseLlm | None = None,
    models: RoleModelInstances | None = None,
    invocation: InvocationContext | None = None,
    budget_reserver: Callable[[dict[str, object]], None] = reserve_budget,
    usage_reporter: Callable[[dict[str, object]], None] = report_usage,
) -> dict[str, Any]:
    resolved = _resolve_role_models(model, models)
    coordinator_model_id = _instance_model_id(resolved.coordinator)
    roles = _SPECIALIST_ROLES[specialist]
    accumulators: dict[str, UsageAccumulator] = {}
    endpoint_seconds: dict[str, float] = {}
    if invocation is not None:
        for reservation in _reservation_payloads(
            specialist, payload, invocation, resolved,
        ):
            budget_reserver(reservation)
        accumulators = {
            role: UsageAccumulator(
                job_id=invocation.job_id,
                operation_id=invocation.role_operation_id(role),
                stage=invocation.stage,
                role=role,
                model=_instance_model_id(resolved.model_for(role)),
            )
            for role in roles
        }
    service = InMemorySessionService()
    root = build_agent_team(models=resolved)
    runner = Runner(agent=root, app_name="harmonia", session_service=service)
    state = payload.model_dump(mode="json")
    state["requested_specialist"] = specialist
    session = await service.create_session(app_name="harmonia", user_id="system", state=state)
    prompt = (
        f"Delegate this request to {specialist} exactly once. Pass this JSON unchanged:\n"
        f"{payload.model_dump_json(exclude_none=True)}"
    )
    try:
        with tracer().start_as_current_span("harmonia.agent.invoke") as invoke_span:
            invoke_span.set_attributes(safe_attributes({
                "job.id": invocation.job_id if invocation else None,
                "stage": invocation.stage if invocation else None,
                "agent": specialist,
                "model": coordinator_model_id,
            }))
            invoke_span.add_event("harmonia.agent.delegate", safe_attributes({
                "agent": specialist,
                "model": _instance_model_id(
                    resolved.model_for(specialist)
                    if specialist in {"sophia_analyst", "ryan_strategist"}
                    else resolved.copywriter
                ),
            }))
            try:
                with tracer().start_as_current_span("harmonia.model.generate") as model_span:
                    model_span.set_attributes(safe_attributes({
                        "job.id": invocation.job_id if invocation else None,
                        "stage": invocation.stage if invocation else None,
                        "agent": specialist,
                        "model": coordinator_model_id,
                    }))
                    async for event in runner.run_async(
                        user_id="system",
                        session_id=session.id,
                        new_message=types.Content(role="user", parts=[types.Part(text=prompt)]),
                    ):
                        accumulator = accumulators.get(getattr(event, "author", ""))
                        if accumulator is not None:
                            accumulator.observe_event(event)
                        metadata = getattr(event, "custom_metadata", None) or {}
                        elapsed = metadata.get("harmonia_endpoint_seconds")
                        if accumulator is not None and isinstance(elapsed, (int, float)):
                            endpoint_seconds[event.author] = (
                                endpoint_seconds.get(event.author, 0.0) + float(elapsed)
                            )
                    model_span.set_attributes(safe_attributes({
                        "input.units": sum(a.input_tokens for a in accumulators.values()),
                        "output.units": sum(a.output_tokens for a in accumulators.values()),
                    }))
            except (ValidationError, ValueError, json.JSONDecodeError) as exc:
                raise AgentProtocolError(f"agent delegation or structured output failed: {exc}") from exc
            completed = await service.get_session(
                app_name="harmonia", user_id="system", session_id=session.id,
            )
            if completed is None:
                raise AgentProtocolError("coordinator session disappeared before output validation")
            final_state = dict(completed.state)
            _validate_run_output(specialist, payload, final_state)
            if invocation is not None:
                trace_id = current_trace_id()
                for role in roles:
                    config = resolved.config_for(role)
                    if config.provider == "vertex_endpoint":
                        record = endpoint_usage_record(
                            invocation=invocation,
                            role=role,
                            model=_instance_model_id(resolved.model_for(role)),
                            elapsed_seconds=endpoint_seconds.get(role, 0.0),
                            estimated_cost_usd=config.reservation_usd or "0.000001",
                            trace_id=trace_id,
                        )
                    else:
                        record = accumulators[role].finalize(trace_id=trace_id)
                    usage_reporter(record.to_wire())
            return final_state
    finally:
        await runner.close()


async def analyze_with_team(
    input: AnalystInput, *, invocation: InvocationContext | None = None,
) -> AnalysisResult:
    input = AnalystInput.model_validate(input)
    if mock_ai_enabled():
        print("[MOCK-AI] coordinator -> sophia_analyst", flush=True)
        raw = mock_analyze(input.title, input.channel, input.transcript, input.prior_learnings)
        return AnalysisResult.model_validate({k: v for k, v in raw.items() if k != "mock"})
    state = await _run_coordinator("sophia_analyst", input, invocation=invocation)
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


async def strategize_with_team(
    input: StrategistInput, *, invocation: InvocationContext | None = None,
) -> StrategistResult:
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
    state = await _run_coordinator("ryan_strategist", input, invocation=invocation)
    result = _validated_state(state, "strategist_result", StrategistResult)
    return _validate_strategy_result(input, result)


async def draft_with_team(
    input: DraftWorkflowInput, *, invocation: InvocationContext | None = None,
) -> DraftWorkflowResult:
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

    state = await _run_coordinator("flo_draft_workflow", input, invocation=invocation)
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
