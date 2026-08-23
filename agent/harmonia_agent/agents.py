"""Harmonia's typed Google ADK coordinator and specialist workflows."""

from __future__ import annotations

import os
import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, TypeVar

from google.adk.agents import Agent, SequentialAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.tools.agent_tool import AgentTool
from pydantic import BaseModel, ValidationError

from .agent_models import (
    ActionPlan,
    AnalysisResult,
    AnalystInput,
    DraftSet,
    DraftWorkflowInput,
    DraftWorkflowResult,
    LiaisonInput,
    StrategistInput,
    StrategistResult,
    validate_draft_references,
)
from .a2ui_models import SurfacePlan, UiContext
from .config import settings
from .gemma_model import VertexGemmaModel
from .generation_policy import generation_config
from .model_catalog import PRICING_VERSION, estimate_text_cost
from .mock_ai import (
    mock_ai_enabled,
    mock_analyze,
    mock_ask,
    mock_drafts,
    mock_ideate,
    mock_plan_actions,
    mock_propose_gap_fillers,
    mock_propose_ideas,
    mock_propose_recycle,
)
from .multimodal import attach_media_evidence
from .memory_bank import MemoryBank, MemoryScope, VertexMemoryBank, format_memory_context
from .telemetry import current_trace_id, safe_attributes, tracer
from .team_runtime import AgentEngineTeamRuntime, TeamRuntime
from .tenant_context import current_tenant
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
    "maya_presenter": ("harmonia_coordinator", "maya_presenter"),
    "nova_liaison": ("harmonia_coordinator", "nova_liaison"),
}
_MAX_OUTPUT_TOKENS = {
    "harmonia_coordinator": 1024,
    "sophia_analyst": 2048,
    "ryan_strategist": 2048,
    "nimi_copywriter": 2048,
    "dara_editor": 2048,
    "temi_planner": 1024,
    "maya_presenter": 2048,
    "nova_liaison": 2048,
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
    presenter: str | BaseLlm
    liaison: str | BaseLlm
    configs: dict[str, RoleModelConfig] = field(default_factory=dict)

    def model_for(self, role: str) -> str | BaseLlm:
        mapping = {
            "harmonia_coordinator": self.coordinator,
            "ryan_strategist": self.strategist,
            "sophia_analyst": self.analyst,
            "nimi_copywriter": self.copywriter,
            "dara_editor": self.editor,
            "temi_planner": self.planner,
            "maya_presenter": self.presenter,
            "nova_liaison": self.liaison,
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
    configured = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if configured:
        os.environ.setdefault("GOOGLE_API_KEY", configured)
    return model or os.environ.get("MODEL_ID", "gemini-3.5-flash")


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
            presenter=shared,
            liaison=shared,
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
        presenter=catalog.presenter.model_id,
        liaison=catalog.liaison.model_id,
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
            "modelPolicy": config.policy_snapshot(),
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
        generate_content_config=generation_config(resolved.config_for("ryan_strategist")),
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
        generate_content_config=generation_config(resolved.config_for("sophia_analyst")),
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
    presenter = Agent(
        model=resolved.presenter,
        generate_content_config=generation_config(resolved.config_for("maya_presenter")),
        name="maya_presenter",
        description=(
            "Composes trustworthy Harmonia A2UI workspaces from bounded entity references."
        ),
        instruction=(
            "Compose the smallest useful Harmonia interface for the supplied operator intent. "
            "Use only component names and entity identifiers present in UiContext. "
            "Never invent domain content, status, risk, cost, URLs, actions, receipts, or evidence. "
            "Prefer one canvas surface; add conversation or approval surfaces only when useful. "
            "Return only the SurfacePlan JSON contract."
        ),
        input_schema=UiContext,
        output_schema=SurfacePlan,
        output_key="surface_plan",
        mode="single_turn",
    )
    copywriter = Agent(
        model=resolved.copywriter,
        generate_content_config=generation_config(resolved.config_for("nimi_copywriter")),
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
        generate_content_config=generation_config(resolved.config_for("dara_editor")),
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
        generate_content_config=generation_config(resolved.config_for("temi_planner")),
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
    from .skills_runtime import build_insight_skillset

    liaison = Agent(
        model=resolved.liaison,
        generate_content_config=generation_config(resolved.config_for("nova_liaison")),
        name="nova_liaison",
        description=(
            "Answers operator questions about jobs, engagement, trends, and posting "
            "windows using its loaded Harmonia skills and read-only live tools."
        ),
        instruction=(
            "You are Harmonia's insight liaison for operators. Use your load_skill "
            "tool first, follow the triggered skill's instructions exactly, and ground "
            "every factual claim in tool output from this conversation. If a tool "
            "fails or returns no data, say exactly that - never substitute recalled "
            "facts or invented numbers. You are strictly read-only: never offer to "
            "publish, approve, delete, or modify anything; point operators to their "
            "approval queue instead."
        ),
        tools=[build_insight_skillset()],
        output_key="liaison_answer",
    )
    return Agent(
        model=resolved.coordinator,
        generate_content_config=generation_config(resolved.config_for("harmonia_coordinator")),
        name="harmonia_coordinator",
        description="Routes Harmonia judgment tasks to typed specialists; never performs external effects.",
        instruction=(
            "Delegate exactly once to the specialist named in the user's task instruction. Use "
            "ryan_strategist for strategy, sophia_analyst for transcript analysis, "
            "flo_draft_workflow for the ordered draft-edit-plan workflow, maya_presenter "
            "for a reference-only A2UI surface plan, and nova_liaison for free-form operator "
            "questions. Never answer the task yourself and never call "
            "publishing or approval systems."
        ),
        sub_agents=[strategist, analyst, presenter, liaison],
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
    if specialist == "maya_presenter":
        _validated_state(state, "surface_plan", SurfacePlan)
        return
    if specialist == "nova_liaison":
        answer = state.get("liaison_answer")
        if not isinstance(answer, str) or not answer.strip():
            raise AgentProtocolError("liaison returned no answer text")
        return
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
    team_runtime: TeamRuntime | None = None,
) -> dict[str, Any]:
    resolved = _resolve_role_models(model, models)
    roles = _SPECIALIST_ROLES[specialist]
    if invocation is not None:
        for reservation in _reservation_payloads(
            specialist, payload, invocation, resolved,
        ):
            budget_reserver(reservation)
    managed_runtime = team_runtime or AgentEngineTeamRuntime(
        resource_name=settings().agent_engine_resource,
    )
    if invocation is not None:
        managed_user_id = invocation.agent_engine_user_id()
    else:
        tenant = current_tenant()
        managed_user_id = f"{tenant.workspace_id}:system:proactive"
    with tracer().start_as_current_span("harmonia.agent.invoke") as invoke_span:
        invoke_span.set_attributes(safe_attributes({
            "job.id": invocation.job_id if invocation else None,
            "workspace.id": invocation.workspace_id if invocation else current_tenant().workspace_id,
            "stage": invocation.stage if invocation else "proactive",
            "agent": specialist,
            "runtime": "agent_engine",
        }))
        invoke_span.add_event("harmonia.agent.delegate", safe_attributes({
            "agent": specialist,
            "runtime": "agent_engine",
        }))
        final_state = await managed_runtime.invoke(
            specialist=specialist,
            payload=payload.model_dump(mode="json"),
            user_id=managed_user_id,
        )
        managed_trace_id = current_trace_id()
    _validate_run_output(specialist, payload, final_state)
    if invocation is not None:
        serialized = payload.model_dump_json(exclude_none=True)
        trace_id = managed_trace_id
        for role in roles:
            config = resolved.config_for(role)
            model_id = _instance_model_id(resolved.model_for(role))
            if config.provider == "vertex_endpoint":
                record = endpoint_usage_record(
                    invocation=invocation,
                    role=role,
                    model=model_id,
                    elapsed_seconds=0,
                    estimated_cost_usd=config.reservation_usd or "0.000001",
                    trace_id=trace_id,
                    model_policy=config.policy_snapshot(),
                )
            else:
                estimated_input, estimated_output = estimate_request_tokens(
                    serialized * (2 if role == "harmonia_coordinator" else 1),
                    config.max_output_tokens,
                )
                accumulator = UsageAccumulator(
                    job_id=invocation.job_id,
                    operation_id=invocation.role_operation_id(role),
                    stage=invocation.stage,
                    role=role,
                    model=model_id,
                    model_policy=config.policy_snapshot(),
                )
                accumulator.input_tokens = estimated_input
                accumulator.output_tokens = estimated_output
                record = accumulator.finalize(trace_id=trace_id)
            usage_reporter(record.to_wire())
    return final_state


async def analyze_with_team(
    input: AnalystInput, *, invocation: InvocationContext | None = None,
    memory: tuple[MemoryBank, MemoryScope] | None = None,
) -> AnalysisResult:
    input = AnalystInput.model_validate(input)
    resolved_memory = configured_memory(invocation) if memory is None else memory
    facts = await _retrieve_memory(query=input.title, memory=resolved_memory)
    if facts:
        input = input.model_copy(update={
            "prior_learnings": _merge_memory(input.prior_learnings, facts),
        })
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


def configured_memory(
    invocation: InvocationContext | None,
) -> tuple[MemoryBank, MemoryScope] | None:
    cfg = settings()
    if not cfg.memory_bank_enabled:
        return None
    resource = cfg.memory_bank_resource or cfg.agent_engine_resource
    if not resource:
        raise ValueError("MEMORY_BANK_RESOURCE or AGENT_ENGINE_RESOURCE is required")
    tenant = current_tenant() if invocation is None else None
    return (
        VertexMemoryBank(resource_name=resource),
        MemoryScope(
            workspace_id=invocation.workspace_id if invocation else tenant.workspace_id,
            brand_id=invocation.brand_id if invocation else tenant.brand_id,
        ),
    )


def _merge_memory(existing: str, facts: list[str]) -> str:
    memory = format_memory_context(facts)
    if not memory:
        return existing
    suffix = f"\nPersisted brand memory:\n{memory}"
    return f"{existing[:max(0, 4000 - len(suffix))]}{suffix}".strip()


async def _retrieve_memory(
    *,
    query: str,
    memory: tuple[MemoryBank, MemoryScope] | None,
) -> list[str]:
    if memory is None:
        return []
    bank, scope = memory
    return await asyncio.to_thread(bank.retrieve, scope=scope, query=query, top_k=3)


async def strategize_with_team(
    input: StrategistInput, *, invocation: InvocationContext | None = None,
    memory: tuple[MemoryBank, MemoryScope] | None = None,
) -> StrategistResult:
    input = StrategistInput.model_validate(input)
    resolved_memory = configured_memory(invocation) if memory is None else memory
    query = input.brief or input.post_text or input.goals_text or input.task
    facts = await _retrieve_memory(query=query, memory=resolved_memory)
    if facts:
        input = input.model_copy(update={
            "prior_learnings": _merge_memory(input.prior_learnings, facts),
        })
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
    memory: tuple[MemoryBank, MemoryScope] | None = None,
) -> DraftWorkflowResult:
    input = DraftWorkflowInput.model_validate(input)
    resolved_memory = configured_memory(invocation) if memory is None else memory
    facts = await _retrieve_memory(query=input.title, memory=resolved_memory)
    if facts:
        input = input.model_copy(update={
            "brand_context": _merge_memory(input.brand_context, facts),
        })
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


async def ask_with_team(
    question: str, *, invocation: InvocationContext | None = None,
) -> str:
    """Answer a free-form operator question via the skill-enabled liaison."""
    input = LiaisonInput(question=question)
    if mock_ai_enabled():
        print("[MOCK-AI] coordinator -> nova_liaison", flush=True)
        return mock_ask(input.question)
    state = await _run_coordinator("nova_liaison", input, invocation=invocation)
    answer = state.get("liaison_answer")
    if not isinstance(answer, str) or not answer.strip():
        raise AgentProtocolError("liaison returned no answer text")
    return answer.strip()
