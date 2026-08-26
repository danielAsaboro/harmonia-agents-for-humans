"""Harmonia's typed Google ADK coordinator and specialist workflows."""

from __future__ import annotations

import os
import asyncio
import logging
import re
from datetime import timedelta
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, TypeVar

from google.adk.agents import Agent, LoopAgent, SequentialAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.tools.agent_tool import AgentTool
from pydantic import BaseModel, ValidationError

from .agent_models import (
    ActionPlan,
    AnalysisResult,
    AnalystInput,
    ContentStrategy,
    DraftSet,
    DraftWorkflowResult,
    EditorialPlan,
    EditorialPlannerInput,
    ProductionDraftInput,
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
)
from .multimodal import attach_media_evidence
from .memory_bank import MemoryBank, MemoryScope, VertexMemoryBank, format_memory_context
from .memory_bank import MemoryFact as RetrievedMemoryFact
from .agent_models import MemoryFact as StrategyMemoryFact
from .ryan_prompt import RYAN_STRATEGIST_INSTRUCTION
from .temi_prompt import TEMI_EDITORIAL_PLANNER_INSTRUCTION
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
from .web_client import report_usage, reserve_budget, resolve_budget_reservation

logger = logging.getLogger("harmonia.agents")

T = TypeVar("T", bound=BaseModel)

_SPECIALIST_ROLES = {
    "nimi_analyst": ("harmonia_coordinator", "nimi_analyst"),
    "ryan_strategist": ("harmonia_coordinator", "ryan_strategist"),
    "temi_editorial_planner": ("harmonia_coordinator", "temi_editorial_planner"),
    "flo_content_engine": ("harmonia_coordinator", "noni_copywriter", "dara_editor"),
    "maya_presenter": ("harmonia_coordinator", "maya_presenter"),
    "nova_liaison": ("harmonia_coordinator", "nova_liaison"),
}
_MAX_OUTPUT_TOKENS = {
    "harmonia_coordinator": 1024,
    "nimi_analyst": 2048,
    "ryan_strategist": 4096,
    "noni_copywriter": 2048,
    "dara_editor": 2048,
    "temi_editorial_planner": 1024,
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
            "nimi_analyst": self.analyst,
            "noni_copywriter": self.copywriter,
            "dara_editor": self.editor,
            "temi_editorial_planner": self.planner,
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
        copywriter=(
            catalog.copywriter.model_id
            if catalog.copywriter.provider == "gemini"
            else VertexGemmaModel(
                model=catalog.copywriter.model_id,
                endpoint=catalog.copywriter.endpoint or "",
            )
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


def _role_task(role: str, specialist: str, payload: BaseModel) -> str:
    if role == "harmonia_coordinator":
        return "route"
    if role == "ryan_strategist":
        return "strategize"
    if role == "nimi_analyst":
        return "analyze_media" if getattr(payload, "media_evidence", None) else "analyze_transcript"
    return {
        "noni_copywriter": "draft_or_revise_x",
        "dara_editor": "review_drafts",
        "temi_editorial_planner": "propose_editorial_plan",
        "maya_presenter": "compose_surface",
        "nova_liaison": "answer_status",
    }[role]


def _enforce_role_eligibility(
    specialist: str, payload: BaseModel, models: RoleModelInstances,
) -> int:
    timeouts: list[int] = []
    for role in _SPECIALIST_ROLES[specialist]:
        config = models.config_for(role)
        task = _role_task(role, specialist, payload)
        if "*" not in config.eligible_tasks and task not in config.eligible_tasks:
            raise ValueError(f"{role} is not eligible for task: {task}")
        timeouts.append(config.timeout_seconds)
    return max(timeouts)


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
            "Turns bounded startup context and Nimi evidence into a grounded strategy proposal."
        ),
        instruction=RYAN_STRATEGIST_INSTRUCTION,
        input_schema=StrategistInput,
        output_schema=StrategistResult,
        output_key="strategist_result",
        mode="single_turn",
    )
    analyst = Agent(
        model=resolved.analyst,
        generate_content_config=generation_config(resolved.config_for("nimi_analyst")),
        name="nimi_analyst",
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
        generate_content_config=generation_config(resolved.config_for("noni_copywriter")),
        name="noni_copywriter",
        description="Writes platform-native X drafts grounded in supplied moments and angles.",
        instruction=(
            "Write only the selected {editorialItem} using its exact {brief}, referenced evidence, "
            "brand context, and constraints. Produce one platform-native X draft. "
            "Previously reviewed drafts, when this is a later loop pass, are {reviewed_drafts?}. "
            "Revise only what needs improvement. Every draft must be at most 280 "
            "characters and may reference only a supplied momentId or angleId. Preserve useful "
            "brand context. Return only the DraftSet JSON contract."
        ),
        input_schema=ProductionDraftInput,
        output_schema=DraftSet,
        output_key="copywriter_drafts",
    )
    editor = Agent(
        model=resolved.editor,
        generate_content_config=generation_config(resolved.config_for("dara_editor")),
        name="dara_editor",
        description="Reviews each Noni draft against brand voice, strategy, and source grounding.",
        instruction=(
            "Review and edit {copywriter_drafts} against the selected editorial item, exact brief, "
            "referenced evidence, and brand context in session "
            "state. Return the reviewed DraftSet. You may revise or omit drafts, "
            "but must preserve each retained draft id, platform, momentId, and angleId. Never add a "
            "new draft. Keep every text at most 280 characters."
        ),
        output_schema=DraftSet,
        output_key="reviewed_drafts",
    )
    planner = Agent(
        model=resolved.planner,
        generate_content_config=generation_config(resolved.config_for("temi_editorial_planner")),
        name="temi_editorial_planner",
        description="Operationalizes one approved Ryan strategy as a bounded editorial plan.",
        instruction=TEMI_EDITORIAL_PLANNER_INSTRUCTION,
        input_schema=EditorialPlannerInput,
        output_schema=EditorialPlan,
        output_key="editorial_plan",
        mode="single_turn",
    )
    revision_loop = LoopAgent(
        name="noni_dara_revision_loop",
        description="Runs at most two bounded Noni writing and Dara review passes.",
        sub_agents=[copywriter, editor],
        max_iterations=2,
    )
    draft_workflow = SequentialAgent(
        name="flo_content_engine",
        description="Runs the bounded Noni-Dara production revision loop.",
        sub_agents=[revision_loop],
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
            "returns status=success, use only its data and cite its evidence source. "
            "If it returns status=error, report the typed error; retry at most once only "
            "when retryable=true. If a tool fails or returns no data, say exactly that - never substitute recalled "
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
            "nimi_analyst for evidence analysis, ryan_strategist for strategy and content plans, "
            "temi_editorial_planner for approved-strategy editorial planning, flo_content_engine "
            "for the bounded Noni-Dara revision loop, maya_presenter "
            "for a reference-only A2UI surface plan, and nova_liaison for free-form operator "
            "questions. Never answer the task yourself and never call "
            "publishing or approval systems."
        ),
        sub_agents=[strategist, analyst, planner, presenter, liaison],
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


def _deterministic_action_plan(reviewed: DraftSet) -> ActionPlan:
    """Create proposals from exact reviewed text; models never choose effect payloads."""
    return ActionPlan(actions=[{"type": "publish_x_post", "text": draft.text} for draft in reviewed.drafts])


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
    if specialist == "nimi_analyst":
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
    if specialist == "temi_editorial_planner":
        planner_input = EditorialPlannerInput.model_validate(payload)
        plan = _validated_state(state, "editorial_plan", EditorialPlan)
        validate_editorial_plan(planner_input, plan)
        return
    try:
        copywriter = _validated_state(state, "copywriter_drafts", DraftSet)
        reviewed = _validated_state(state, "reviewed_drafts", DraftSet)
        draft_input = ProductionDraftInput.model_validate(payload)
        supplied = AnalysisResult(
            summary="Selected-item evidence", moments=draft_input.referencedMoments,
            angles=draft_input.referencedAngles,
        )
        validate_draft_references(copywriter, supplied)
        validate_draft_references(reviewed, supplied)
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
    budget_resolver: Callable[[dict[str, object]], None] = resolve_budget_reservation,
    usage_reporter: Callable[[dict[str, object]], None] = report_usage,
    team_runtime: TeamRuntime | None = None,
) -> dict[str, Any]:
    resolved = _resolve_role_models(model, models)
    roles = _SPECIALIST_ROLES[specialist]
    timeout_seconds = _enforce_role_eligibility(specialist, payload, resolved)
    reserved: list[dict[str, object]] = []
    dispatched = False
    try:
        if invocation is not None:
            for reservation in _reservation_payloads(
                specialist, payload, invocation, resolved,
            ):
                budget_reserver(reservation)
                reserved.append(reservation)
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
            async with asyncio.timeout(timeout_seconds):
                dispatched = True
                final_state = await managed_runtime.invoke(
                    specialist=specialist,
                    payload=payload.model_dump(mode="json"),
                    user_id=managed_user_id,
                    session_key=(
                        f"{invocation.operation_id}:{specialist}"
                        if invocation else f"proactive:{specialist}"
                    ),
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
    except Exception:  # noqa: BLE001 - preserve original runtime/provider failure
        if invocation is not None:
            for reservation in reserved:
                try:
                    budget_resolver({
                        "jobId": invocation.job_id,
                        "operationId": reservation["operationId"],
                        "outcome": "uncertain" if dispatched else "not_invoked",
                        "reason": (
                            "agent team failed after managed runtime dispatch"
                            if dispatched else "agent team failed before managed runtime dispatch"
                        ),
                    })
                except Exception:  # noqa: BLE001 - never mask the causal provider failure
                    logger.exception(
                        "budget resolution failed for operation %s",
                        reservation["operationId"],
                    )
        raise


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
        print("[MOCK-AI] coordinator -> nimi_analyst", flush=True)
        raw = mock_analyze(input.title, input.channel, input.transcript, input.prior_learnings)
        return AnalysisResult.model_validate({k: v for k, v in raw.items() if k != "mock"})
    state = await _run_coordinator("nimi_analyst", input, invocation=invocation)
    return _validated_state(state, "analysis_result", AnalysisResult)


def validate_strategy_grounding(
    input: StrategistInput,
    strategy: ContentStrategy,
) -> ContentStrategy:
    """Fail closed when Ryan exceeds supplied evidence or authority."""
    source_ids = {item.id for item in [*input.analysis.moments, *input.analysis.angles]}
    audience_ids = {item.id for item in input.campaign.audiences}
    valid_ids = {
        input.company.evidenceId,
        input.campaign.evidenceId,
        *source_ids,
        *(item.id for item in input.performance),
        *(item.id for item in input.memoryFacts),
    }
    referenced: set[str] = set()
    for group in (
        strategy.objectives, strategy.audiencePriorities, strategy.pillars,
        strategy.campaignThemes, strategy.channelRoles, strategy.kpis,
        strategy.briefs, strategy.assumptions,
    ):
        for item in group:
            referenced.update(item.evidenceRefs)
    invalid = referenced - valid_ids
    if invalid:
        raise AgentProtocolError(f"unknown evidence references: {sorted(invalid)}")
    requested = set(input.campaign.requestedChannels)
    supported = set(input.campaign.supportedChannels)
    for brief in strategy.briefs:
        if not set(brief.evidenceRefs) & source_ids:
            raise AgentProtocolError(f"brief {brief.id} requires source evidence")
        if brief.audienceId not in audience_ids:
            raise AgentProtocolError(f"brief {brief.id} references unknown audience")
        invalid_candidates = set(brief.channelCandidates) - requested
        if invalid_candidates:
            raise AgentProtocolError(f"brief {brief.id} contains unrequested channels: {sorted(invalid_candidates)}")
    for role in strategy.channelRoles:
        if role.channel not in requested:
            raise AgentProtocolError(f"channel was not requested: {role.channel}")
        if role.operationallySupported != (role.channel in supported):
            raise AgentProtocolError(f"incorrect operational support for channel: {role.channel}")
    if strategy.horizonWeeks != input.campaign.horizonWeeks or strategy.version != input.revision:
        raise AgentProtocolError("strategy horizon or version does not match input")
    serialized = strategy.model_dump_json().lower()
    if re.search(
        r"\b(memory|ryan|i|we|harmonia)\b.{0,40}\b(approved|published|executed|authorized)\b"
        r"|\bautomatic publishing\b|\breceipt(?:id)?\b|\beffect payload\b",
        serialized,
    ):
        raise AgentProtocolError("strategy authority overreach")
    return strategy


def _validate_strategy_result(input: StrategistInput, result: StrategistResult) -> StrategistResult:
    validate_strategy_grounding(input, result.strategy)
    return result


def _windows_overlap(start_a, end_a, start_b, end_b) -> bool:
    return start_a < end_b and start_b < end_a


def _assert_acyclic_dependencies(items_by_id) -> None:
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(item_id: str) -> None:
        if item_id in visiting:
            raise AgentProtocolError("editorial plan contains cyclic dependencies")
        if item_id in visited:
            return
        visiting.add(item_id)
        for dependency in items_by_id[item_id].dependencies:
            visit(dependency)
        visiting.remove(item_id)
        visited.add(item_id)

    for item_id in items_by_id:
        visit(item_id)


_TEMI_AUTHORITY_PATTERNS = tuple(re.compile(pattern, re.IGNORECASE) for pattern in (
    r"\b(?:memory bank|memory|strategy|strategic context)\b.{0,40}\b(?:authoriz(?:e|es|ed|ation)|approv(?:e|es|ed|al)|permit(?:s|ted)?)\b",
    r"\b(?:temi|i|we|harmonia)\s+(?:has\s+|have\s+|will\s+)?(?:approved|rejected|authorized)\b",
    r"\b(?:content|campaign|post|plan)\s+(?:is|was|has been)\s+(?:approved|rejected|authorized)\b",
    r"\bapproval\s+(?:is|was|has been)\s+(?:granted|recorded|received)\b",
    r"\b(?:temi|i|we|harmonia)\s+(?:has\s+|have\s+|will\s+|is\s+|are\s+|was\s+|were\s+)?publish(?:es|ed|ing)?\b",
    r"\b(?:post|content|campaign)\s+(?:is|was|has been)\s+published\b",
    r"\bpublished successfully\b",
    r"\bpublish\s+(?:it|this|now)\b",
    r"\b(?:post|content|campaign|event)\s+(?:is|was|has been)\s+scheduled\b",
    r"\b(?:created|updated|scheduled|booked|wrote)\b.{0,40}\b(?:google|external) calendar\b",
    r"\b(?:google|external) calendar\b.{0,40}\b(?:created|updated|scheduled|booked|changed)\b",
    r"\b(?:added|written|synced)\b.{0,20}\b(?:to|into)\b.{0,20}\bgoogle calendar\b",
    r"\b(?:google|external) calendar (?:event|id)\b",
    r"\breceipt(?:id)?\b.{0,40}\b(?:created|recorded|issued|attached)\b",
    r"\breceipt[-_ ]?(?:id|[a-z]*\d+)\b",
    r"\b(?:execute|create|construct|send|return)\b.{0,30}\beffect payload\b",
    r"\beffect payload\b.{0,30}\b(?:created|ready|attached)\b",
    r"\b(?:use|access|retrieve|request|include)\b.{0,30}\bcredentials?\b",
    r"\bcredentials?\b.{0,20}\b(?:token|secret|key)\b",
    r"\b(?:write|draft|provide|include|return)\b.{0,30}\bfinal (?:post )?copy\b",
    r"\bfinal post copy\b.{0,20}(?:\bis\b|:)",
))


def _contains_temi_authority_overreach(input: EditorialPlannerInput, plan: EditorialPlan) -> bool:
    authored = [
        plan.summary,
        plan.sequencingRationale,
        plan.cadenceRationale,
        *plan.assumptions,
    ]
    briefs = {brief.id: brief for brief in input.strategy.briefs}
    for item in plan.items:
        authored.extend((
            item.planningRationale,
            item.selectionRationale,
            *item.requiredAssets,
        ))
        inherited_constraints = set(briefs[item.briefId].constraints)
        authored.extend(
            constraint for constraint in item.constraints
            if constraint not in inherited_constraints
        )
    return any(
        pattern.search(text)
        for text in authored
        for pattern in _TEMI_AUTHORITY_PATTERNS
    )


def validate_editorial_plan(
    input: EditorialPlannerInput,
    plan: EditorialPlan,
) -> EditorialPlan:
    """Fail closed when Temi exceeds the approved strategy or planning boundary."""
    input = EditorialPlannerInput.model_validate(input)
    plan = EditorialPlan.model_validate(plan)

    if input.strategyDigest != input.strategyApproval.payloadDigest:
        raise AgentProtocolError("strategy approval digest does not match strategy digest")
    if input.strategyDigest != plan.approvedStrategyDigest:
        raise AgentProtocolError("approved strategy digest does not match plan")
    if input.strategyVersion != input.strategy.version:
        raise AgentProtocolError("strategy version does not match approved strategy")
    if input.strategyApproval.revision != input.strategyVersion:
        raise AgentProtocolError("approval revision does not match strategy version")
    if input.strategyApproval.decidedAt > input.horizonStartAt:
        raise AgentProtocolError("strategy approval was not decided before the horizon")
    if input.strategyApproval.expiresAt < input.horizonStartAt:
        raise AgentProtocolError("strategy approval expired before the horizon")
    if plan.version != input.revision:
        raise AgentProtocolError("plan version does not match planning revision")
    if (
        plan.horizonStartAt != input.horizonStartAt
        or plan.horizonEndAt != input.horizonEndAt
        or plan.timezone != input.timezone
    ):
        raise AgentProtocolError("plan horizon or timezone does not match planner input")
    expected_horizon = timedelta(weeks=input.strategy.horizonWeeks)
    if input.horizonEndAt - input.horizonStartAt != expected_horizon:
        raise AgentProtocolError("editorial horizon duration does not match strategy horizonWeeks")

    briefs = {brief.id: brief for brief in input.strategy.briefs}
    themes = {theme.name for theme in input.strategy.campaignThemes}
    pillars = {pillar.name for pillar in input.strategy.pillars}
    capabilities = {
        capability.channel: set(capability.formats)
        for capability in input.channelCapabilities
    }
    supported_roles = {
        role.channel: set(role.formats)
        for role in input.strategy.channelRoles
        if role.operationallySupported
    }
    item_ids = [item.id for item in plan.items]
    if len(item_ids) != len(set(item_ids)):
        raise AgentProtocolError("editorial item ids must be unique")
    items_by_id = {item.id: item for item in plan.items}

    if len(plan.items) > input.productionCapacity.maxItems:
        raise AgentProtocolError("editorial plan exceeds production capacity")

    for item in plan.items:
        brief = briefs.get(item.briefId)
        if brief is None:
            raise AgentProtocolError(f"unknown brief: {item.briefId}")
        exact_fields = {
            "objective": brief.objective,
            "audienceId": brief.audienceId,
            "funnelStage": brief.funnelStage,
            "intendedConversion": brief.intendedConversion,
            "ctaIntent": brief.ctaIntent,
            "kpi": brief.kpi,
        }
        for field_name, expected in exact_fields.items():
            if getattr(item, field_name) != expected:
                raise AgentProtocolError(
                    f"editorial item {field_name} does not match brief {brief.id}"
                )
        if set(item.evidenceRefs) != set(brief.evidenceRefs):
            raise AgentProtocolError(f"editorial evidence is outside brief {brief.id}")
        if item.campaignTheme not in themes:
            raise AgentProtocolError(f"unknown campaign theme: {item.campaignTheme}")
        if item.contentPillar not in pillars:
            raise AgentProtocolError(f"unknown content pillar: {item.contentPillar}")
        if item.channel not in brief.channelCandidates or item.channel not in supported_roles:
            raise AgentProtocolError(f"unsupported channel: {item.channel}")
        allowed_formats = capabilities.get(item.channel, set()) & supported_roles[item.channel]
        if item.format not in brief.formatCandidates or item.format not in allowed_formats:
            raise AgentProtocolError(f"unsupported format: {item.format}")
        if not set(brief.constraints).issubset(item.constraints):
            raise AgentProtocolError(f"editorial item omits constraints from brief {brief.id}")
        if (
            item.productionDeadlineAt < input.horizonStartAt
            or item.publicationWindowStartAt < input.horizonStartAt
            or item.publicationWindowEndAt > input.horizonEndAt
        ):
            raise AgentProtocolError(f"editorial item {item.id} is outside editorial horizon")
        unknown_dependencies = set(item.dependencies) - set(item_ids)
        if unknown_dependencies:
            raise AgentProtocolError(
                f"editorial item {item.id} has unknown dependencies: {sorted(unknown_dependencies)}"
            )

    _assert_acyclic_dependencies(items_by_id)
    for item in plan.items:
        for dependency_id in item.dependencies:
            dependency = items_by_id[dependency_id]
            if dependency.publicationWindowEndAt > item.publicationWindowStartAt:
                raise AgentProtocolError(
                    f"dependency {dependency_id} publication window must end at or before "
                    f"dependent item {item.id} starts"
                )

    ordered_items = sorted(plan.items, key=lambda item: item.publicationWindowStartAt)
    for index, item in enumerate(ordered_items):
        for other in ordered_items[index + 1:]:
            if item.channel != other.channel:
                continue
            if _windows_overlap(
                item.publicationWindowStartAt, item.publicationWindowEndAt,
                other.publicationWindowStartAt, other.publicationWindowEndAt,
            ):
                raise AgentProtocolError("duplicate editorial slot on the same channel")
            gap = other.publicationWindowStartAt - item.publicationWindowStartAt
            if gap < timedelta(hours=input.cadenceConstraints.minimumHoursBetweenItems):
                raise AgentProtocolError("editorial plan violates minimum channel cadence")
        for commitment in input.existingCommitments:
            if item.channel == commitment.channel and _windows_overlap(
                item.publicationWindowStartAt, item.publicationWindowEndAt,
                commitment.publicationWindowStartAt, commitment.publicationWindowEndAt,
            ):
                raise AgentProtocolError("editorial slot collides with an existing commitment")

    weekly_total: dict[int, int] = {}
    weekly_channel: dict[tuple[int, str], int] = {}
    for item in plan.items:
        week = (item.publicationWindowStartAt - input.horizonStartAt).days // 7
        weekly_total[week] = weekly_total.get(week, 0) + 1
        channel_key = (week, item.channel)
        weekly_channel[channel_key] = weekly_channel.get(channel_key, 0) + 1
    if any(count > input.productionCapacity.maxItemsPerWeek for count in weekly_total.values()):
        raise AgentProtocolError("editorial plan exceeds weekly production capacity")
    if any(
        count > input.cadenceConstraints.maxItemsPerChannelPerWeek
        for count in weekly_channel.values()
    ):
        raise AgentProtocolError("editorial plan exceeds per-channel weekly cadence")

    selected = items_by_id[plan.selectedNextItemId]
    if selected.dependencies:
        raise AgentProtocolError("selected editorial item is blocked by dependencies")
    eligible = [item for item in plan.items if not item.dependencies]
    if selected.selectionScore < max(item.selectionScore for item in eligible):
        raise AgentProtocolError("selected item is not the highest-scoring eligible item")

    if _contains_temi_authority_overreach(input, plan):
        raise AgentProtocolError("editorial plan contains authority overreach")
    return plan


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
) -> list[RetrievedMemoryFact]:
    if memory is None:
        return []
    bank, scope = memory
    return await asyncio.to_thread(bank.retrieve, scope=scope, query=query, top_k=3)


async def prepare_strategist_input(
    input: StrategistInput, *, invocation: InvocationContext | None = None,
    memory: tuple[MemoryBank, MemoryScope] | None = None,
) -> StrategistInput:
    input = StrategistInput.model_validate(input)
    resolved_memory = configured_memory(invocation) if memory is None else memory
    query = f"{input.company.company} {input.company.product} {input.source_title}"
    facts = await _retrieve_memory(query=query, memory=resolved_memory)
    if facts:
        input = input.model_copy(update={
            "memoryFacts": [
                *input.memoryFacts,
                *(StrategyMemoryFact(
                    id=f"memory:{fact.evidence_ref.kind}:{fact.evidence_ref.record_id}",
                    content=fact.fact,
                    firestoreEvidenceRef=(
                        f"jobs/{fact.evidence_ref.job_id}/{fact.evidence_ref.kind}/"
                        f"{fact.evidence_ref.record_id}"
                    ),
                ) for fact in facts),
            ][:5],
        })
    return input


async def strategize_with_team(
    input: StrategistInput, *, invocation: InvocationContext | None = None,
    memory: tuple[MemoryBank, MemoryScope] | None = None, prepared: bool = False,
) -> StrategistResult:
    input = StrategistInput.model_validate(input)
    if not prepared:
        input = await prepare_strategist_input(input, invocation=invocation, memory=memory)
    if mock_ai_enabled():
        print("[MOCK-AI] coordinator -> ryan_strategist", flush=True)
        raise RuntimeError("Ryan has no mock strategy path; inject a TeamRuntime in tests")
    state = await _run_coordinator("ryan_strategist", input, invocation=invocation)
    result = _validated_state(state, "strategist_result", StrategistResult)
    return _validate_strategy_result(input, result)


async def plan_with_team(
    input: EditorialPlannerInput, *, invocation: InvocationContext | None = None,
) -> EditorialPlan:
    """Run Temi and fail closed against the approved planning boundary."""
    input = EditorialPlannerInput.model_validate(input)
    if mock_ai_enabled():
        raise RuntimeError("Temi has no mock editorial-plan path; inject a TeamRuntime in tests")
    state = await _run_coordinator("temi_editorial_planner", input, invocation=invocation)
    plan = _validated_state(state, "editorial_plan", EditorialPlan)
    return validate_editorial_plan(input, plan)


async def draft_with_team(
    input: ProductionDraftInput, *, invocation: InvocationContext | None = None,
) -> DraftWorkflowResult:
    input = ProductionDraftInput.model_validate(input)
    analysis = AnalysisResult(
        summary="Evidence referenced by the selected approved brief.",
        moments=input.referencedMoments,
        angles=input.referencedAngles,
    )
    if mock_ai_enabled():
        raise RuntimeError("Noni has no mock production path; inject a TeamRuntime in tests")

    state = await _run_coordinator("flo_content_engine", input, invocation=invocation)
    copywriter = _validated_state(state, "copywriter_drafts", DraftSet)
    reviewed = _validated_state(state, "reviewed_drafts", DraftSet)
    plan = _deterministic_action_plan(reviewed)
    try:
        validate_draft_references(copywriter, analysis)
        validate_draft_references(reviewed, analysis)
        return DraftWorkflowResult(
            copywriter_drafts=copywriter, reviewed_drafts=reviewed, action_plan=plan,
        )
    except (ValidationError, ValueError) as exc:
        raise AgentProtocolError(f"invalid draft workflow result: {exc}") from exc


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
