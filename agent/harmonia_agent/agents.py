"""Harmonia's typed Google ADK coordinator and specialist workflows."""

from __future__ import annotations

import os
import asyncio
import hashlib
import json
import logging
import re
import time
from datetime import datetime, timedelta, timezone
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, TypeVar

from google.adk.agents import Agent
from google.adk.models.base_llm import BaseLlm
from pydantic import BaseModel, ValidationError

from .agent_models import (
    SourceAnalysis,
    AnalystInput,
    AnalystMemoryFact,
    ContentDraft,
    ContentStrategy,
    CopywriterInput,
    DraftWorkflowResult,
    EditorialPlan,
    EditorialPlannerInput,
    EditorialAssessment,
    EditorialReview,
    EditorialReviewInput,
    LiaisonInput,
    LiaisonAnswer,
    StrategistInput,
    StrategistResult,
)
from .a2ui_models import SurfacePlan, UiContext
from .agent_errors import AgentContractError
from .config import settings
from .gemma_model import VertexGemmaModel
from .generation_policy import generation_config
from .model_catalog import PRICING_VERSION, estimate_text_cost
from .mock_ai import (
    mock_ai_enabled,
    mock_analyze,
    mock_ask,
)
from .multimodal import attach_media_evidence
from .memory_bank import MemoryBank, MemoryScope, VertexMemoryBank
from .memory_bank import MemoryFact as RetrievedMemoryFact
from .agent_models import MemoryFact as StrategyMemoryFact
from .ryan_prompt import RYAN_STRATEGIST_INSTRUCTION
from .temi_prompt import TEMI_EDITORIAL_PLANNER_INSTRUCTION
from .noni_prompt import NONI_COPYWRITER_INSTRUCTION
from .nimi_prompt import NIMI_ANALYST_INSTRUCTION
from .maya_prompt import MAYA_PRESENTER_INSTRUCTION
from .nova_prompt import NOVA_LIAISON_INSTRUCTION
from .nova_liaison import (
    TRACE_KEY as LIAISON_TRACE_KEY,
    record_liaison_tool,
    record_liaison_tool_error,
    reset_liaison_trace,
    validate_liaison_answer,
)
from .dara_prompt import DARA_EDITOR_INSTRUCTION
from .telemetry import current_trace_id, safe_attributes, tracer
from .activity_models import AgentActivityRecord
from .activity_projection import invocation_activity, tool_activity
from .team_runtime import AgentEngineTeamRuntime, TeamRuntime
from .tenant_context import current_tenant
from .role_models import RoleModelConfig, load_role_model_catalog
from .usage import (
    InvocationContext,
    UsageAccumulator,
    endpoint_usage_record,
    estimate_request_tokens,
)
from .web_client import record_agent_activity, report_usage, reserve_budget, resolve_budget_reservation

logger = logging.getLogger("harmonia.agents")

T = TypeVar("T", bound=BaseModel)

_SPECIALIST_ROLES = {
    "nimi_analyst": ("harmonia_coordinator", "nimi_analyst"),
    "ryan_strategist": ("harmonia_coordinator", "ryan_strategist"),
    "temi_editorial_planner": ("harmonia_coordinator", "temi_editorial_planner"),
    "noni_copywriter": ("harmonia_coordinator", "noni_copywriter"),
    "dara_editor": ("harmonia_coordinator", "dara_editor"),
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
        return "analyze_media" if getattr(payload, "mediaEvidence", None) else "analyze_transcript"
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
        instruction=NIMI_ANALYST_INSTRUCTION,
        input_schema=AnalystInput,
        output_schema=SourceAnalysis,
        output_key="source_analysis",
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
        instruction=MAYA_PRESENTER_INSTRUCTION,
        input_schema=UiContext,
        output_schema=SurfacePlan,
        output_key="surface_plan",
        mode="single_turn",
    )
    copywriter = Agent(
        model=resolved.copywriter,
        generate_content_config=generation_config(resolved.config_for("noni_copywriter")),
        name="noni_copywriter",
        description="Writes one platform-native X draft grounded in supplied moments and angles.",
        instruction=NONI_COPYWRITER_INSTRUCTION,
        input_schema=CopywriterInput,
        output_schema=ContentDraft,
        output_key="copywriter_draft",
        tools=[],
        mode="single_turn",
    )
    editor = Agent(
        model=resolved.editor,
        generate_content_config=generation_config(resolved.config_for("dara_editor")),
        name="dara_editor",
        description="Returns a structured review of one exact Noni draft without rewriting it.",
        instruction=DARA_EDITOR_INSTRUCTION,
        input_schema=EditorialReviewInput,
        output_schema=EditorialAssessment,
        output_key="editorial_assessment",
        tools=[],
        mode="single_turn",
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
    from .skills_runtime import build_insight_skillset

    liaison = Agent(
        model=resolved.liaison,
        generate_content_config=generation_config(resolved.config_for("nova_liaison")),
        name="nova_liaison",
        description=(
            "Answers operator questions about jobs, engagement, trends, and posting "
            "windows using its loaded Harmonia skills and read-only live tools."
        ),
        instruction=NOVA_LIAISON_INSTRUCTION,
        tools=[build_insight_skillset()],
        output_key="liaison_answer",
        before_agent_callback=reset_liaison_trace,
        after_tool_callback=record_liaison_tool,
        on_tool_error_callback=record_liaison_tool_error,
    )
    return Agent(
        model=resolved.coordinator,
        generate_content_config=generation_config(resolved.config_for("harmonia_coordinator")),
        name="harmonia_coordinator",
        description="Routes Harmonia judgment tasks to typed specialists; never performs external effects.",
        instruction=(
            "Delegate exactly once to the specialist named in the user's task instruction. Use "
            "nimi_analyst for evidence analysis, ryan_strategist for strategy and content plans, "
            "temi_editorial_planner for approved-strategy editorial planning, noni_copywriter "
            "for one application-bounded draft pass, dara_editor for one structured review, maya_presenter "
            "for a reference-only A2UI surface plan, and nova_liaison for free-form operator "
            "questions. Never answer the task yourself and never call "
            "publishing or approval systems."
        ),
        sub_agents=[strategist, analyst, planner, copywriter, editor, presenter, liaison],
        tools=[],
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


_NONI_URL_PATTERN = re.compile(r"https?://[^\s\]\[(){}<>,]+", re.IGNORECASE)
_NONI_WORD_PATTERN = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?")
_NONI_CLAIM_QUALIFIERS = {
    "a", "an", "and", "according", "as", "at", "by", "could", "describes",
    "evidence", "for", "from", "in", "indicates", "into", "may", "might", "of", "on", "or",
    "reported", "reports", "says", "source", "suggests", "that", "the", "their",
    "this", "to", "was", "we", "were", "with",
}
_NONI_RELATIONAL_CONNECTORS = {
    "after", "and", "as", "before", "from", "higher", "less", "lower", "more",
    "or", "over", "than", "to", "under", "versus", "vs",
}
_NONI_NUMBER_TERMS = {
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
    "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
    "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty",
    "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "thousand",
    "million",
}
_NONI_METRIC_UNITS = {
    "percent", "percentage", "hours", "hour", "days", "day", "weeks", "week",
    "months", "month", "years", "year", "minutes", "minute", "seconds", "second",
}
_NONI_STYLISTIC_LEADIN_PATTERN = re.compile(
    r"^(?:please(?:\s+|\s*[,;:\u2013\u2014-]\s*))?(?:"
    r"ask(?:ing)?(?:\s+yourself)?(?:\s+to)?|consider(?:ing)?|imagin(?:e|ing)|"
    r"notic(?:e|ing)|pictur(?:e|ing)|stop(?:ping)?|think(?:ing)?(?:\s+about)?|"
    r"turn(?:ing)?|try(?:ing)?(?:\s+to)?"
    r")(?:\s+|\s*[,;:\u2013\u2014-]\s*)",
    re.IGNORECASE,
)
# These policy recognizers preserve specific authority/CTA diagnostics. They do
# not decide which creative clauses are accepted; the closed positive grammar
# below is the acceptance boundary for every non-factual creative clause.
_NONI_AUTHORITY_PATTERNS = tuple(re.compile(pattern, re.IGNORECASE) for pattern in (
    r"\b(?:draft|post|content|campaign|copy)\s+(?:is\s+|was\s+|has been\s+)?approved\b",
    r"\bpublication\s+(?:is\s+|was\s+|has been\s+)?approved\b",
    r"\bapproval\s+(?:is\s+|was\s+|has been\s+)?granted\b",
    r"\bapprove\s+(?:this|the|it)\b",
    r"\bapproved\s+for\s+(?:publication|publishing|release)\b",
    r"\bschedule\s+(?:this|the|it)\b",
    r"\bscheduled\s+(?:for|at|on)\b",
    r"\bpublish\s+(?:this|the|it|now)\b",
    r"\bsend\s+(?:this|the|it)\s+live\b",
    r"\b(?:published successfully|has been published|was published)\b",
    r"\b(?:execute|construct|create|send|return)\b.{0,30}\beffect payload\b",
    r"\beffect payload\b.{0,30}\b(?:ready|executed|created|queued|sent)\b",
    r"\breceipt(?:\s+|[-_])?id\b",
    r"\breceipt\b.{0,20}\b(?:created|recorded|issued|attached|saved|stored)\b",
    r"\b(?:use|access|retrieve|request|include)\b.{0,30}\b(?:api\s+)?credentials?\b",
    r"\bcredentials?\b.{0,20}\b(?:token|secret|key)\b",
    r"\b(?:use|access|retrieve|request|include)\b.{0,30}\bapi\s+(?:token|secret|key)\b",
    r"\b(?:token|secret|api key)\b.{0,20}\b(?:provided|saved|stored|retrieved)\b",
    r"\b(?:plan|revise|set|change)\b.{0,20}\b(?:strategy|campaign|content plan)\b",
    r"\blaunch\s+(?:this|the|it)(?:\s+now)?\b",
    r"(?:^|\n)\s*launch\b.{0,30}\bnow\b",
    r"\bverification\b.{0,20}\b(?:complete|passed|recorded|verified)\b",
))
_NONI_STYLISTIC_AUTHORITY_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE) for pattern in (
        r"^(?:approve|approving)\b",
        r"^(?:launch|launching)\b",
        r"^(?:post|posting|publish|publishing|release|releasing)\b",
        r"^(?:go|going)\s+live\b",
        r"^(?:verify|verifying)\b",
        r"^(?:change|changing|mutate|mutating|set|setting)\b.{0,30}"
        r"\b(?:workflow|workflow state)\b",
        r"^(?:schedule|scheduling)\b.{0,30}\b(?:campaign|content|copy|it|post|publication|this)\b",
        r"^(?:queue|queueing)\b.{0,30}\b(?:campaign|content|copy|it|post|publication|this)\b",
        r"^(?:send|sending)\b.{0,30}\blive\b",
        r"^(?:construct|constructing|execute|executing|queue|queueing|return|returning)\b"
        r".{0,30}\beffect(?:\s+payload)?\b",
        r"^(?:create|creating|issue|issuing|record|recording|save|saving)\b"
        r".{0,30}\breceipt\b",
        r"^(?:access|accessing|include|including|request|requesting|retrieve|retrieving|"
        r"use|using)\b.{0,30}\b(?:api\s+)?(?:credentials?|key|secret|token)\b",
    )
)
_NONI_WRAPPED_AUTHORITY_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE) for pattern in (
        r"\b(?:approving|launching|posting|publishing|releasing|verifying)\b",
        r"\b(?:approve|launch|post|publish|release|verify)\b.{0,30}"
        r"\b(?:campaign|content|copy|it|now|post|publication|this)\b",
        r"\b(?:go|going|send|sending)\s+live\b",
        r"\b(?:queue|queueing|schedule|scheduling)\b.{0,30}"
        r"\b(?:campaign|content|copy|it|post|publication|this)\b",
        r"\b(?:construct|constructing|execute|executing|queue|queueing|return|returning)"
        r"\b.{0,30}\beffect(?:\s+payload)?\b",
        r"\b(?:create|creating|issue|issuing|record|recording|save|saving)\b"
        r".{0,30}\breceipt\b",
        r"\b(?:access|accessing|include|including|request|requesting|retrieve|retrieving|"
        r"use|using)\b.{0,30}\b(?:api\s+)?(?:credentials?|key|secret|token)\b",
        r"\b(?:change|changing|mutate|mutating|set|setting)\b.{0,30}\bworkflow\b",
    )
)
_NONI_FACTUAL_STATUS_PATTERN = re.compile(
    r"\b(?:chosen|endorsed|loved|preferred|recommended|trusted|used)\s+by\b|"
    r"\b(?:category|industry|market|sector)\s+(?:favorite|leader|leading|winner)\b|"
    r"\b(?:favorite|leader|leading|winner)\s+(?:in|of)\s+(?:the\s+)?"
    r"(?:category|industry|market|sector)\b",
    re.IGNORECASE,
)
_NONI_SAFE_CREATIVE_COPY_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE) for pattern in (
        r"^stop\s+guessing[.!]?$",
        r"^(?:are\s+you\s+)?ready\s+to\s+stop\s+guessing\?$",
        r"^still\s+guessing\?$",
        r"^why\s+(?:continue|keep)\s+guessing\?$",
    )
)
_NONI_SAFE_META_CREATIVE_PATTERN = re.compile(
    r"^(?:a|an)\s+"
    r"(?:(?:cautious|concise|creative|direct|evidence-led|founder-focused|"
    r"platform-native|single)\s+){1,4}"
    r"(?:hook|layout|phrasing|style|tone|wording)\s+"
    r"(?:suits\s+(?:the\s+selected|this)\s+(?:x\s+)?(?:item|post)|"
    r"is\s+(?:a\s+)?creative\s+choice\s+for\s+limited\s+evidence)[.]?$",
    re.IGNORECASE,
)
_NONI_ATTENTION_VOCATIVE_PATTERN = re.compile(
    r"^(?:hey|hello|hi)(?:\s*[,;:])?\s+"
    r"(?P<audience>[A-Za-z0-9][A-Za-z0-9'&-]*"
    r"(?:\s+[A-Za-z0-9][A-Za-z0-9'&-]*){0,5})"
    r"\s*[:,]\s+(?P<body>.+)$",
    re.IGNORECASE,
)
_NONI_AUDIENCE_HEAD_VOCATIVE_PATTERN = re.compile(
    r"^(?P<audience>(?:[A-Za-z][A-Za-z'-]*\s+){0,3}"
    r"(?:builders?|customers?|creators?|developers?|executives?|founders?|"
    r"leaders?|marketers?|operators?|owners?|professionals?|startups?|teams?|users?))"
    r"\s*[:,]\s+(?P<body>.+)$",
    re.IGNORECASE,
)
_NONI_LEGACY_VOCATIVE_PATTERN = re.compile(
    r"^(?P<audience>[A-Za-z-]+|[A-Z][A-Za-z-]+\s+[A-Z][A-Za-z-]+)"
    r"\s*[:,]\s+(?P<body>.+)$",
)
_NONI_TRAILING_VOCATIVE_PATTERN = re.compile(
    r"[,;:]\s*(?P<audience>[A-Za-z][A-Za-z0-9'&-]*"
    r"(?:\s+[A-Za-z][A-Za-z0-9'&-]*){0,3})$",
    re.IGNORECASE,
)


def _noni_urls(text: str) -> set[str]:
    return {match.rstrip(".!?:;'") for match in _NONI_URL_PATTERN.findall(text)}


def _noni_token_sequence(text: str) -> list[str]:
    without_urls = _NONI_URL_PATTERN.sub(" ", text.lower().replace("-", " "))
    return [
        term
        for term in _NONI_WORD_PATTERN.findall(without_urls)
        if term not in _NONI_CLAIM_QUALIFIERS
    ]


def _noni_literal_sequence(text: str) -> list[str]:
    return _NONI_WORD_PATTERN.findall(text.lower().replace("-", " "))


def _noni_support_sequence(text: str) -> list[str]:
    without_urls = _NONI_URL_PATTERN.sub(" ", text.lower().replace("-", " "))
    return [
        term
        for term in _NONI_WORD_PATTERN.findall(without_urls)
        if term not in _NONI_CLAIM_QUALIFIERS or term in _NONI_RELATIONAL_CONNECTORS
    ]


def _noni_terms(text: str) -> set[str]:
    return set(_noni_token_sequence(text))


def _noni_contiguous_phrase(needle: list[str], haystack: list[str]) -> bool:
    if not needle or len(needle) > len(haystack):
        return False
    width = len(needle)
    return any(
        haystack[index:index + width] == needle
        for index in range(len(haystack) - width + 1)
    )


def _noni_split_audience_address(text: str) -> tuple[str, str] | None:
    for pattern in (
        _NONI_ATTENTION_VOCATIVE_PATTERN,
        _NONI_AUDIENCE_HEAD_VOCATIVE_PATTERN,
        _NONI_LEGACY_VOCATIVE_PATTERN,
    ):
        if match := pattern.match(text.strip()):
            return match.group("audience"), match.group("body").strip()
    return None


def _noni_semantic_variants(text: str) -> list[str]:
    """Return authored clauses plus their cores after safe stylistic lead-ins."""
    variants: list[str] = []
    for clause, _terminal in _noni_clauses(text):
        core = clause.strip()
        variants.append(core)
        if address := _noni_split_audience_address(core):
            _audience, core = address
            variants.append(core)
        while match := _NONI_STYLISTIC_LEADIN_PATTERN.match(core):
            core = core[match.end():].strip(" ,:;-.")
            if not core:
                break
            variants.append(core)
    return variants


def _noni_stylistic_cores(text: str) -> list[str]:
    cores: list[str] = []
    for clause, _terminal in _noni_clauses(text):
        core = clause.strip()
        if address := _noni_split_audience_address(core):
            _audience, core = address
        stripped_leadin = False
        while match := _NONI_STYLISTIC_LEADIN_PATTERN.match(core):
            core = core[match.end():].strip(" ,:;-.\u2013\u2014")
            stripped_leadin = True
            if not core:
                break
        if stripped_leadin and core:
            cores.append(core)
    return cores


def _noni_metric_relations(tokens: list[str]) -> list[tuple[str, str]]:
    relations: list[tuple[str, str]] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if not (token in _NONI_NUMBER_TERMS or re.fullmatch(r"\d+(?:\.\d+)?", token)):
            index += 1
            continue
        number = [token]
        cursor = index + 1
        while cursor < len(tokens) and tokens[cursor] in _NONI_NUMBER_TERMS:
            number.append(tokens[cursor])
            cursor += 1
        if cursor < len(tokens) and tokens[cursor] in _NONI_METRIC_UNITS:
            relations.append((" ".join(number), tokens[cursor]))
            index = cursor + 1
            continue
        index += 1
    return relations


def _noni_all_strings(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, BaseModel):
        return _noni_all_strings(value.model_dump(mode="json"))
    if isinstance(value, dict):
        return [text for item in value.values() for text in _noni_all_strings(item)]
    if isinstance(value, (list, tuple)):
        return [text for item in value for text in _noni_all_strings(item)]
    return []


def _noni_evidence_fields(input: CopywriterInput) -> dict[str, tuple[str, ...]]:
    evidence: dict[str, tuple[str, ...]] = {}
    for moment in input.referencedMoments:
        evidence[moment.id] = tuple(filter(None, (
            moment.title, moment.hook, moment.quote, moment.visualHook,
            moment.captionSafeRegion,
        )))
    for angle in input.referencedAngles:
        evidence[angle.id] = (angle.title, angle.rationale)
    return evidence


def _noni_unsupported_category(claim: str) -> str | None:
    lowered = claim.lower()
    if re.search(r"(?:[$€£]\s*\d|\b\d+(?:\.\d+)?\s*%|\b(?:revenue|roi|conversion rate)\b)", lowered):
        return "invented metric"
    if re.search(r"\b(?:trend|trending|viral|fastest growing|fastest-growing)\b", lowered):
        return "invented trend"
    if re.search(
        r"\b(?:customers?|users?|founders?)\s+(?:say|said|love|report|reported)\b|"
        r"\bchanged their lives\b|\btestimonial\b",
        lowered,
    ):
        return "invented testimonial"
    if re.search(
        r"\bharmonia\s+(?:can|does|will|generates?|automates?|supports?|creates?)\b",
        lowered,
    ):
        return "invented product capability"
    return None


def _noni_prohibited_phrases(input: CopywriterInput) -> list[str]:
    sources = [*input.constraints, *input.brief.constraints, *input.editorialItem.constraints]
    sources.extend(re.split(r"[\n;]", input.brandContext))
    phrases: list[str] = []
    for source in sources:
        directive = re.search(
            r"\b(?:never|do not|don't|avoid|exclude|no)\b\s*"
            r"(?:say|use|mention|claim|promise|include|imply)?\s*(.+)",
            source,
            re.IGNORECASE,
        )
        labelled = re.search(r"\b(?:exclusions?|safety)\s*:\s*(.+)", source, re.IGNORECASE)
        phrase = (directive or labelled)
        if phrase:
            phrases.extend(
                re.sub(r"^(?:either|any|all)\s+", "", part.strip(" ."), flags=re.IGNORECASE)
                for part in re.split(r",|\b(?:or|nor|and)\b", phrase.group(1), flags=re.IGNORECASE)
            )
    return [phrase for phrase in phrases if _noni_terms(phrase)]


def _noni_validate_lineage(input: CopywriterInput, draft: ContentDraft) -> None:
    expected = (
        input.planId, input.planDigest, input.strategyDigest,
        input.editorialItemId, input.briefId,
    )
    actual = (
        draft.planId, draft.planDigest, draft.strategyDigest,
        draft.editorialItemId, draft.briefId,
    )
    if actual != expected:
        raise AgentProtocolError("Noni draft lineage does not match the selected input")
    if draft.platform != input.platform or draft.format != input.format:
        raise AgentProtocolError("Noni draft platform or format diverges from the selected item")
    alignment = (
        ("audience", draft.audienceId, input.brief.audienceId),
        ("objective", draft.objective, input.brief.objective),
        ("funnel", draft.funnelStage, input.brief.funnelStage),
        ("CTA", draft.ctaIntent, input.brief.ctaIntent),
        ("intended conversion", draft.intendedConversion, input.brief.intendedConversion),
    )
    for label, actual_value, expected_value in alignment:
        if actual_value != expected_value:
            raise AgentProtocolError(
                f"Noni draft {label} alignment metadata diverges from the exact brief"
            )
    expected_revision = 1 if input.passType == "original" else 2
    if draft.revision != expected_revision:
        raise AgentProtocolError("Noni draft revision does not match the requested pass")
    if input.passType == "revision" and (
        input.priorDraft is None or draft.priorDraftId != input.priorDraft.id
    ):
        raise AgentProtocolError("Noni revision does not link the exact prior draft")
    if input.passType == "revision":
        if input.priorReview is None:
            raise AgentProtocolError("Noni revision requires the exact prior review")
        required_issue_ids = {issue.id for issue in input.priorReview.issues}
        if set(draft.addressedIssueIds) != required_issue_ids:
            raise AgentProtocolError(
                "Noni revision addressed issue ids must equal all required prior review issue ids"
            )


def _noni_validate_references(
    input: CopywriterInput, draft: ContentDraft,
) -> dict[str, tuple[str, ...]]:
    evidence = _noni_evidence_fields(input)
    expected_ids = set(evidence)
    draft_ids = set(draft.evidenceRefs)
    unknown = draft_ids - expected_ids
    if unknown:
        raise AgentProtocolError(f"Noni draft contains unknown evidence ids: {sorted(unknown)}")
    missing = expected_ids - draft_ids
    if missing:
        raise AgentProtocolError(f"Noni draft is missing selected evidence ids: {sorted(missing)}")

    claim_ids = {reference for claim in draft.claims for reference in claim.evidenceRefs}
    undeclared = claim_ids - draft_ids
    if undeclared:
        raise AgentProtocolError(f"Noni claims contain undeclared evidence ids: {sorted(undeclared)}")
    unused = draft_ids - claim_ids
    if unused:
        raise AgentProtocolError(f"Noni draft contains unused evidence ids: {sorted(unused)}")
    return evidence


def _noni_validate_constraints(input: CopywriterInput, draft: ContentDraft) -> None:
    applicable = set(input.constraints) | set(input.brief.constraints) | set(input.editorialItem.constraints)
    applied = set(draft.appliedConstraints)
    missing = applicable - applied
    if missing:
        raise AgentProtocolError(f"Noni draft is missing applicable constraints: {sorted(missing)}")
    unknown = applied - applicable
    if unknown:
        raise AgentProtocolError(f"Noni draft invents constraint references: {sorted(unknown)}")

    authored = "\n".join((
        draft.text, draft.ctaTreatment, *draft.assumptions,
        *(claim.text for claim in draft.claims),
    ))
    authored_terms = _noni_terms(authored)
    normalized_authored = " ".join(_NONI_WORD_PATTERN.findall(authored.lower().replace("-", " ")))
    for phrase in _noni_prohibited_phrases(input):
        phrase_terms = _noni_terms(phrase)
        normalized_phrase = " ".join(_NONI_WORD_PATTERN.findall(phrase.lower().replace("-", " ")))
        if normalized_phrase in normalized_authored or phrase_terms <= authored_terms:
            raise AgentProtocolError(f"Noni draft contains prohibited constraint language: {phrase}")


def _noni_validate_urls_alternatives_and_authority(
    input: CopywriterInput, draft: ContentDraft,
) -> None:
    supplied_urls = _noni_urls("\n".join(_noni_all_strings(input)))
    authored = "\n".join((
        draft.text, draft.ctaTreatment, *draft.assumptions,
        *(claim.text for claim in draft.claims),
    ))
    invented_urls = _noni_urls(authored) - supplied_urls
    if invented_urls:
        raise AgentProtocolError(f"Noni draft URL was not supplied: {sorted(invented_urls)}")
    if re.search(
        r"\b(?:option|alternative)\s*(?:1|one|a)\b.*"
        r"\b(?:option|alternative)\s*(?:2|two|b)\b",
        authored,
        re.IGNORECASE | re.DOTALL,
    ):
        raise AgentProtocolError("Noni draft contains multiple final alternatives")
    if re.search(
        r"(?:^|\s)A\s*[\).:-].*(?:^|\s)B\s*[\).:-]",
        authored,
        re.IGNORECASE | re.DOTALL,
    ):
        raise AgentProtocolError("Noni draft contains multiple final alternatives")
    if re.search(
        r"(?:^|\s)1\s*[\).:-].*(?:^|\s)2\s*[\).:-]",
        authored,
        re.IGNORECASE | re.DOTALL,
    ):
        raise AgentProtocolError("Noni draft contains multiple final alternatives")
    authored_without_urls = _NONI_URL_PATTERN.sub(" ", authored)
    if re.search(r"\S(?:[^/\n]*?)\s+/\s+(?:[^/\n]*?)\S", authored_without_urls):
        raise AgentProtocolError("Noni draft contains multiple final alternatives")
    if any(pattern.search(authored) for pattern in _NONI_AUTHORITY_PATTERNS):
        raise AgentProtocolError(
            "Noni draft contains approval, scheduling, publishing, effect, receipt, "
            "or credential authority overreach"
        )
    authored_fields = (
        draft.text, draft.ctaTreatment, *draft.assumptions,
        *(claim.text for claim in draft.claims),
    )
    if any(
        pattern.search(variant)
        for field in authored_fields
        for variant in _noni_semantic_variants(field)
        for pattern in _NONI_STYLISTIC_AUTHORITY_PATTERNS
    ):
        raise AgentProtocolError(
            "Noni draft contains approval, scheduling, publishing, effect, receipt, "
            "or credential authority overreach"
        )
    if any(
        pattern.search(core)
        for field in authored_fields
        for core in _noni_stylistic_cores(field)
        for pattern in _NONI_WRAPPED_AUTHORITY_PATTERNS
    ):
        raise AgentProtocolError(
            "Noni draft contains approval, scheduling, publishing, effect, receipt, "
            "or credential authority overreach"
        )


def _noni_validate_claim_support(
    evidence: dict[str, tuple[str, ...]], draft: ContentDraft,
) -> None:
    for claim in draft.claims:
        claim_tokens = _noni_support_sequence(claim.text)
        cited_fields = [
            field
            for reference in claim.evidenceRefs
            for field in evidence[reference]
        ]
        field_tokens = [_noni_support_sequence(field) for field in cited_fields]
        if any(_noni_contiguous_phrase(claim_tokens, tokens) for tokens in field_tokens):
            continue

        category = _noni_unsupported_category(claim.text)
        if category:
            raise AgentProtocolError(f"Noni draft contains {category}: {claim.text}")
        claim_terms = set(claim_tokens)
        claim_content_terms = claim_terms - _NONI_RELATIONAL_CONNECTORS
        available_terms = {term for tokens in field_tokens for term in tokens}
        unsupported = claim_content_terms - available_terms
        if unsupported:
            raise AgentProtocolError(
                "cited evidence does not textually support claim terms: "
                f"{sorted(unsupported)}"
            )
        if not any(claim_content_terms <= set(tokens) for tokens in field_tokens):
            raise AgentProtocolError(
                "cited evidence must support the claim within one evidence field"
            )
        claim_connectors = [
            token for token in claim_tokens if token in _NONI_RELATIONAL_CONNECTORS
        ]
        if claim_connectors and not any(
            [token for token in tokens if token in _NONI_RELATIONAL_CONNECTORS]
            == claim_connectors
            for tokens in field_tokens
            if claim_content_terms <= set(tokens)
        ):
            raise AgentProtocolError(
                "cited evidence does not preserve the exact claim relation connectors"
            )
        if _noni_metric_relations(claim_tokens):
            raise AgentProtocolError(
                "cited evidence does not establish the exact claim relation or order"
            )
        raise AgentProtocolError(
            "cited evidence does not support the claim as a normalized contiguous phrase"
        )


def _noni_validate_unbound_audience_addresses(draft: ContentDraft) -> None:
    authored_fields = (draft.text, draft.ctaTreatment, *draft.assumptions)
    for field in authored_fields:
        for clause, _terminal in _noni_clauses(field):
            prefix_address = _noni_split_audience_address(clause)
            trailing_match = _NONI_TRAILING_VOCATIVE_PATTERN.search(clause.strip())
            trailing_address = False
            if trailing_match:
                creative_core = clause[:trailing_match.start()].strip()
                trailing_address = any(
                    _noni_is_supported_creative_copy(f"{creative_core}{terminal}")
                    for terminal in (".", "?")
                )
            if prefix_address or trailing_address:
                raise AgentProtocolError(
                    "Noni draft contains an audience address without an "
                    "operator-supplied display label"
                )


_NONI_CONFLICTING_CTA_PATTERNS = tuple(re.compile(pattern, re.IGNORECASE) for pattern in (
    r"\b(?:buy|purchase)\b",
    r"\bsign\s+up\b",
    r"\b(?:join|subscribe)\b",
    r"\bdownload\b",
    r"\b(?:start|begin)\s+(?:a\s+)?(?:trial|subscription)\b",
    r"\b(?:book|booking|schedule|scheduling)\s+(?:a\s+|the\s+)?"
    r"(?:call|consultation|meeting)\b",
    r"\b(?:call|contact|contacting)\s+(?:our\s+)?(?:sales|team|us)\b",
    r"\b(?:speak|speaking|talk|talking)\s+(?:to\s+|with\s+)?"
    r"(?:our\s+)?(?:sales|team|us)\b",
))


def _noni_validate_cta_clauses(input: CopywriterInput, draft: ContentDraft) -> None:
    expected_tokens = _noni_token_sequence(input.brief.ctaIntent)
    expected_normalized = " ".join(
        _NONI_WORD_PATTERN.findall(input.brief.ctaIntent.lower().replace("-", " "))
    )
    authored_fields = (draft.text, draft.ctaTreatment, *draft.assumptions)
    for field in authored_fields:
        for clause in _noni_semantic_variants(field):
            clause_tokens = _noni_token_sequence(clause)
            if clause_tokens == expected_tokens:
                continue
            normalized = " ".join(
                _NONI_WORD_PATTERN.findall(clause.lower().replace("-", " "))
            )
            negates_expected = (
                _noni_contiguous_phrase(expected_tokens, clause_tokens)
                and set(normalized.split())
                & {"avoid", "don't", "never", "no", "not", "without"}
            )
            conflicts = any(
                pattern.search(normalized) and not pattern.search(expected_normalized)
                for pattern in _NONI_CONFLICTING_CTA_PATTERNS
            )
            if negates_expected or conflicts:
                raise AgentProtocolError(
                    "Noni draft contains a conflicting CTA or funnel action"
                )


def _noni_validate_brief_alignment(input: CopywriterInput, draft: ContentDraft) -> None:
    _noni_validate_cta_clauses(input, draft)
    _noni_validate_unbound_audience_addresses(draft)

    cta_tokens = _noni_token_sequence(input.brief.ctaIntent)
    if not cta_tokens:
        raise AgentProtocolError("Noni draft CTA intent has no substantive terms")
    exact_cta = _noni_literal_sequence(input.brief.ctaIntent)
    exact_treatment = _noni_literal_sequence(draft.ctaTreatment)
    if _noni_contains_factual_assertion(draft.ctaTreatment):
        raise AgentProtocolError("Noni draft CTA treatment contains an undeclared factual assertion")
    if exact_treatment != exact_cta:
        raise AgentProtocolError(
            "Noni draft CTA treatment diverges from the exact brief intent"
        )
    conversion_terms = _noni_terms(input.brief.intendedConversion)
    if not set(cta_tokens) <= conversion_terms:
        raise AgentProtocolError("Noni draft CTA intent diverges from the intended conversion")
    body_clauses = [
        _noni_literal_sequence(clause)
        for clause, _terminal in _noni_clauses(draft.text)
    ]
    if exact_treatment not in body_clauses:
        raise AgentProtocolError("Noni draft text must contain the exact CTA treatment")

    objective_terms = _noni_terms(input.brief.objective)
    if len(_noni_terms(draft.text) & objective_terms) < min(2, len(objective_terms)):
        raise AgentProtocolError("Noni draft objective diverges from the exact brief")


def _noni_clauses(text: str) -> list[tuple[str, str]]:
    without_urls = _NONI_URL_PATTERN.sub(" ", text)
    return [
        (match.group(1).strip(), match.group(2))
        for match in re.finditer(r"([^.!?\n]+)([.!?]?)", without_urls)
        if match.group(1).strip()
    ]


def _noni_contains_factual_assertion(text: str) -> bool:
    tokens = _noni_token_sequence(text)
    if _noni_metric_relations(tokens):
        return True
    if re.search(
        r"(?:[$€£]\s*\d|\b\d+(?:\.\d+)?\s*(?:%|x\b|hours?|days?|weeks?|months?|years?))",
        text,
        re.IGNORECASE,
    ):
        return True
    if re.search(r"\b(?:may|might)\s+[a-z][a-z-]+", text, re.IGNORECASE):
        return True
    if _noni_unsupported_category(text) is not None:
        return True
    if _NONI_FACTUAL_STATUS_PATTERN.search(text):
        return True
    if set(tokens) & {
        "accelerates", "automates", "best", "better", "delivers", "doubled",
        "doubles", "enables", "faster", "improved", "improves", "increased",
        "increases", "wins", "won", "works", "worked",
        "endorsement", "endorsed", "guarantee", "guaranteed", "growth", "outcome",
        "outcomes", "performance", "result", "results", "revenue", "roi", "sales",
        "trusted", "worldwide",
    }:
        return True
    return bool(re.search(
        r"\b(?:harmonia|company|companies|product|customers?|users?|teams?|platform|tool|"
        r"workflow|agent|system)\b\s+(?:can\s+|could\s+|does\s+|do\s+|will\s+|has\s+|"
        r"have\s+|is\s+|are\s+|was\s+|were\s+|may\s+|might\s+)?[a-z][a-z-]+",
        text,
        re.IGNORECASE,
    ))


def _noni_is_supported_creative_copy(text: str) -> bool:
    stripped = text.strip()
    return any(pattern.fullmatch(stripped) for pattern in _NONI_SAFE_CREATIVE_COPY_PATTERNS)


def _noni_is_supported_meta_creative_assumption(text: str) -> bool:
    return _NONI_SAFE_META_CREATIVE_PATTERN.fullmatch(text.strip()) is not None


def _noni_validate_authored_grammar_and_factual_ledger(
    draft: ContentDraft,
) -> None:
    claim_clauses = [
        _noni_literal_sequence(claim.text)
        for claim in draft.claims
    ]
    cta_clause = _noni_literal_sequence(draft.ctaTreatment)
    assumption_clauses = [
        _noni_literal_sequence(assumption)
        for assumption in draft.assumptions
    ]

    authored_assumptions = {
        tuple(_noni_literal_sequence(clause))
        for clause, _terminal in _noni_clauses(draft.text)
    }
    for assumption, literal in zip(
        draft.assumptions, assumption_clauses, strict=True,
    ):
        authored = tuple(literal) in authored_assumptions
        supported = (
            _noni_is_supported_creative_copy(assumption)
            if authored
            else _noni_is_supported_meta_creative_assumption(assumption)
        )
        if _noni_contains_factual_assertion(assumption) or not supported:
            raise AgentProtocolError(
                "Noni draft assumption must follow the supported non-factual "
                "creative grammar; unsupported action or authority overreach: "
                f"{assumption}"
            )

    for clause, terminal in _noni_clauses(draft.text):
        literal = _noni_literal_sequence(clause)
        if literal in claim_clauses or literal == cta_clause:
            continue
        if literal in assumption_clauses and _noni_is_supported_creative_copy(
            f"{clause}{terminal}",
        ):
            continue
        raise AgentProtocolError(
            "Noni draft contains uncited factual statement or undeclared substantive clause: "
            f"{clause}"
        )


def _noni_validate_claim_expression(draft: ContentDraft) -> None:
    authored_clauses = [
        *_noni_clauses(draft.text),
        *_noni_clauses(draft.ctaTreatment),
    ]
    for claim in draft.claims:
        literal = _noni_literal_sequence(claim.text)
        if not any(
            literal == _noni_literal_sequence(clause)
            for clause, _terminal in authored_clauses
        ):
            raise AgentProtocolError(
                "Noni draft contains a phantom claim or uncited factual statement: "
                f"{claim.text}"
            )


def validate_content_draft(
    input: CopywriterInput, draft: ContentDraft,
) -> ContentDraft:
    """Fail closed when one Noni result exceeds its exact production boundary."""
    input = CopywriterInput.model_validate(input)
    draft = ContentDraft.model_validate(draft)
    _validate_ascii_only_boundary(draft, "Noni draft")
    _noni_validate_lineage(input, draft)
    evidence = _noni_validate_references(input, draft)
    _noni_validate_constraints(input, draft)
    _noni_validate_urls_alternatives_and_authority(input, draft)
    _noni_validate_claim_support(evidence, draft)
    _noni_validate_brief_alignment(input, draft)
    _noni_validate_claim_expression(draft)
    _noni_validate_authored_grammar_and_factual_ledger(draft)
    return draft


def _validate_ascii_only_boundary(value: BaseModel, label: str) -> None:
    """Reject Unicode until every semantic guard is Unicode-aware."""
    pending: list[object] = [value.model_dump(mode="json")]
    while pending:
        item = pending.pop()
        if isinstance(item, str) and not item.isascii():
            raise AgentProtocolError(
                f"{label} violates the conservative ASCII-only safety policy"
            )
        if isinstance(item, dict):
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)


_DARA_ISSUE_PATHS = {
    "grounding": {"text", "claims", "evidenceRefs"},
    "brief_alignment": {"text", "audienceId", "objective", "funnelStage", "intendedConversion"},
    "brand_voice": {"text", "assumptions", "appliedConstraints"},
    "platform_constraints": {"text", "platform", "format"},
    "cta": {"text", "ctaTreatment", "intendedConversion"},
    "safety": {"text", "claims", "assumptions", "appliedConstraints"},
    "clarity": {"text", "claims", "assumptions"},
}
_DARA_REPLACEMENT_OR_AUTHORITY = re.compile(
    r"\b(?:replace\s+(?:the\s+)?(?:post|copy|draft)\s+with|use\s+this\s+(?:copy|post)|"
    r"option\s*\d+\s*:|approved\s+for|publish(?:ing)?\s+(?:this|now)|"
    r"schedule(?:d)?\s+(?:it|this|for|at|on)|receipt(?:\s+|[-_])?id|"
    r"effect\s+payload|execute(?:d|\s+this)?)\b",
    re.IGNORECASE,
)


def validate_editorial_assessment(
    input: CopywriterInput,
    draft: ContentDraft,
    assessment: EditorialAssessment,
) -> EditorialAssessment:
    """Validate Dara's judgment without granting workflow metadata authority."""
    input = CopywriterInput.model_validate(input)
    draft = validate_content_draft(input, ContentDraft.model_validate(draft))
    assessment = EditorialAssessment.model_validate(assessment)
    _validate_ascii_only_boundary(assessment, "Dara assessment")
    evidence_ids = {
        item.id for item in [*input.referencedMoments, *input.referencedAngles]
    }
    constraints = {
        *input.constraints, *input.brief.constraints, *input.editorialItem.constraints,
    }
    for check in assessment.checks:
        unknown_evidence = set(check.evidenceRefs) - evidence_ids
        if unknown_evidence:
            raise AgentProtocolError(
                f"Dara assessment contains unknown evidence ids: {sorted(unknown_evidence)}"
            )
        unknown_constraints = set(check.constraintRefs) - constraints
        if unknown_constraints:
            raise AgentProtocolError(
                f"Dara assessment contains unknown constraint references: {sorted(unknown_constraints)}"
            )
        if check.dimension == "grounding" and draft.claims and not check.evidenceRefs:
            raise AgentProtocolError("Dara grounding check must cite supplied evidence")
        if check.dimension == "brand_voice" and constraints and not check.constraintRefs:
            raise AgentProtocolError("Dara brand voice check must cite supplied constraints")
        if check.dimension == "safety" and constraints and not check.constraintRefs:
            raise AgentProtocolError("Dara safety check must cite supplied constraints")
    for issue in assessment.issues:
        if issue.fieldPath not in _DARA_ISSUE_PATHS[issue.category]:
            raise AgentProtocolError(
                f"Dara {issue.category} issue has an invalid field path: {issue.fieldPath}"
            )
        unknown_evidence = set(issue.evidenceRefs) - evidence_ids
        if unknown_evidence:
            raise AgentProtocolError(
                f"Dara assessment contains unknown evidence ids: {sorted(unknown_evidence)}"
            )
        unknown_constraints = set(issue.constraintRefs) - constraints
        if unknown_constraints:
            raise AgentProtocolError(
                f"Dara assessment contains unknown constraint references: {sorted(unknown_constraints)}"
            )
        if _DARA_REPLACEMENT_OR_AUTHORITY.search(issue.instruction):
            raise AgentProtocolError(
                "Dara issue instruction contains replacement copy, alternatives, or authority overreach"
            )
    if input.passType == "original" and assessment.resolvedIssueIds:
        raise AgentProtocolError("Dara original assessment cannot resolve prior issues")
    if input.passType == "revision":
        if input.priorReview is None:
            raise AgentProtocolError("Dara revision assessment requires the prior review")
        prior_issue_ids = {issue.id for issue in input.priorReview.issues}
        resolved = set(assessment.resolvedIssueIds)
        unknown = resolved - prior_issue_ids
        if unknown:
            raise AgentProtocolError(
                f"Dara revision assessment contains unknown resolved issue ids: {sorted(unknown)}"
            )
        if assessment.verdict == "accepted" and resolved != prior_issue_ids:
            raise AgentProtocolError(
                "Dara accepted revision must resolve exactly every prior issue"
            )
    return assessment


def materialize_editorial_review(
    input: CopywriterInput,
    draft: ContentDraft,
    assessment: EditorialAssessment,
    *,
    reviewed_at: datetime,
) -> EditorialReview:
    """Attach deterministic review identity, exact lineage, and a trusted UTC time."""
    input = CopywriterInput.model_validate(input)
    draft = ContentDraft.model_validate(draft)
    assessment = validate_editorial_assessment(input, draft, assessment)
    if reviewed_at.tzinfo is None or reviewed_at.utcoffset() != timedelta(0):
        raise AgentProtocolError("Dara review timestamp must be timezone-aware UTC")
    seed = "\0".join((
        input.planId, input.planDigest, input.strategyDigest,
        input.editorialItemId, input.briefId, draft.id, str(draft.revision),
    ))
    return EditorialReview.model_validate({
        "id": f"review-{hashlib.sha256(seed.encode()).hexdigest()[:16]}",
        "planId": input.planId, "planDigest": input.planDigest,
        "strategyDigest": input.strategyDigest,
        "editorialItemId": input.editorialItemId, "briefId": input.briefId,
        "draftId": draft.id, "revision": draft.revision,
        "verdict": assessment.verdict,
        "reviewedAt": reviewed_at.astimezone(timezone.utc).isoformat(),
        "checks": assessment.checks, "issues": assessment.issues,
        "resolvedIssueIds": assessment.resolvedIssueIds,
    })


def run_noni_dara_loop(
    input: CopywriterInput,
    invoke_noni: Callable[[CopywriterInput], ContentDraft | dict[str, object]],
    invoke_dara: Callable[
        [CopywriterInput, ContentDraft], EditorialAssessment | dict[str, object]
    ],
    *,
    reviewed_at: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
) -> DraftWorkflowResult:
    """Run exactly one Noni draft and at most one Dara-requested revision."""
    try:
        original_input = CopywriterInput.model_validate(input)
    except ValidationError as exc:
        raise AgentProtocolError(f"invalid Noni input: {exc}") from exc
    if original_input.passType != "original":
        raise AgentProtocolError("Noni-Dara loop requires an original input")
    _validate_ascii_only_boundary(original_input, "Noni input")

    try:
        original = ContentDraft.model_validate(invoke_noni(original_input))
    except ValidationError as exc:
        raise AgentProtocolError(f"invalid Noni draft: {exc}") from exc
    validate_content_draft(original_input, original)
    try:
        first_assessment = EditorialAssessment.model_validate(
            invoke_dara(original_input, original)
        )
    except ValidationError as exc:
        raise AgentProtocolError(f"invalid Dara review: {exc}") from exc
    first_assessment = validate_editorial_assessment(
        original_input, original, first_assessment,
    )
    first_review = materialize_editorial_review(
        original_input, original, first_assessment, reviewed_at=reviewed_at(),
    )
    if first_review.verdict == "accepted":
        return DraftWorkflowResult(
            originalDraft=original,
            reviews=[first_review],
            revisionDraft=None,
            acceptedDraft=original,
        )

    revision_payload = {
        field: getattr(original_input, field)
        for field in CopywriterInput.model_fields
    }
    revision_payload.update({
        "passType": "revision",
        "priorDraft": original,
        "priorReview": first_review,
    })
    try:
        revision_input = CopywriterInput.model_validate(revision_payload)
        _validate_ascii_only_boundary(revision_input, "Noni revision input")
        revision = ContentDraft.model_validate(invoke_noni(revision_input))
    except ValidationError as exc:
        raise AgentProtocolError(f"invalid Noni draft: {exc}") from exc
    validate_content_draft(revision_input, revision)
    try:
        final_assessment = EditorialAssessment.model_validate(
            invoke_dara(revision_input, revision)
        )
    except ValidationError as exc:
        raise AgentProtocolError(f"invalid Dara review: {exc}") from exc
    final_assessment = validate_editorial_assessment(
        revision_input, revision, final_assessment,
    )
    final_review = materialize_editorial_review(
        revision_input, revision, final_assessment, reviewed_at=reviewed_at(),
    )
    if final_review.verdict != "accepted":
        raise AgentProtocolError(
            "second Dara revise verdict requires operator attention; no third Noni invocation"
        )
    return DraftWorkflowResult(
        originalDraft=original,
        reviews=[first_review, final_review],
        revisionDraft=revision,
        acceptedDraft=revision,
    )


_NIMI_AUTHORITY_OVERREACH = re.compile(
    r"\b(?:approv(?:e|ed|al)|reject(?:ed|ion)?|authori[sz](?:e[sd]?|ation)|"
    r"publish(?:ed|ing)?|schedul(?:e|ed|ing)|execut(?:e|ed|ing)|receipt|verified\s+live|"
    r"final\s+(?:post|copy)|use\s+this\s+(?:post|copy)|call\s+to\s+action|cta|"
    r"content\s+pillar|campaign\s+objective|kpi)\b",
    re.IGNORECASE,
)


def validate_source_analysis(
    input: AnalystInput,
    analysis: SourceAnalysis,
) -> SourceAnalysis:
    """Fail closed when Nimi exceeds the supplied source and advisory evidence."""
    input = AnalystInput.model_validate(input)
    analysis = SourceAnalysis.model_validate(analysis)
    _validate_ascii_only_boundary(input, "Nimi input")
    _validate_ascii_only_boundary(analysis, "Nimi analysis")
    if analysis.sourceDigest != input.sourceDigest:
        raise AgentProtocolError("Nimi analysis source digest does not match the input")

    segments = {segment.id: segment for segment in input.transcriptSegments}
    frames = {
        frame.id: frame
        for frame in (input.mediaEvidence.frames if input.mediaEvidence else [])
    }
    performance_ids = {item.id for item in input.performanceObservations}
    memory_ids = {item.id for item in input.memoryFacts}
    moment_ids = {moment.id for moment in analysis.moments}
    source_ids = set(segments) | set(frames) | moment_ids
    all_ids = source_ids | performance_ids | memory_ids

    for moment in analysis.moments:
        unknown_segments = set(moment.transcriptSegmentRefs) - set(segments)
        if unknown_segments:
            raise AgentProtocolError(
                f"Nimi moment contains unknown transcript segment ids: {sorted(unknown_segments)}"
            )
        cited = [segments[ref] for ref in moment.transcriptSegmentRefs]
        cited_text = " ".join(segment.text for segment in cited)
        if moment.quote not in cited_text:
            raise AgentProtocolError("Nimi moment exact quote is absent from cited transcript segments")
        if moment.startSec < min(segment.startSec for segment in cited) or moment.endSec > max(segment.endSec for segment in cited):
            raise AgentProtocolError("Nimi moment time bounds exceed cited transcript segments")
        if input.mediaEvidence and moment.endSec > input.mediaEvidence.duration_sec:
            raise AgentProtocolError("Nimi moment time bounds exceed media duration")
        unknown_visual = set(moment.visualEvidenceIds) - set(frames)
        if unknown_visual:
            raise AgentProtocolError(
                f"Nimi moment contains unknown visual evidence ids: {sorted(unknown_visual)}"
            )
        if (moment.cropSuitability or moment.captionSafeRegion) and not moment.visualEvidenceIds:
            raise AgentProtocolError("Nimi visual production claims require supplied visual evidence")

    allowed_by_kind = {
        "source": source_ids,
        "trend": source_ids,
        "meme": source_ids,
        "performance": performance_ids,
        "memory": memory_ids,
    }
    for angle in analysis.angles:
        unknown = set(angle.evidenceRefs) - all_ids
        if unknown:
            raise AgentProtocolError(
                f"Nimi angle contains unknown evidence ids: {sorted(unknown)}"
            )
        if not set(angle.evidenceRefs).issubset(allowed_by_kind[angle.kind]):
            raise AgentProtocolError(
                f"Nimi {angle.kind} angle uses the wrong evidence kind"
            )

    semantic_text = " ".join([
        analysis.summary, *analysis.assumptions,
        *(value for moment in analysis.moments for value in (
            moment.title, moment.hook, *moment.assumptions,
        )),
        *(value for angle in analysis.angles for value in (
            angle.title, angle.rationale, *angle.assumptions,
        )),
    ])
    if _NIMI_AUTHORITY_OVERREACH.search(semantic_text):
        raise AgentProtocolError(
            "Nimi analysis contains strategy, final copy, or effect authority overreach"
        )
    return analysis


def _validated_liaison_state(state: dict[str, Any]) -> LiaisonAnswer:
    raw = state.get("liaison_answer")
    if not isinstance(raw, str) or not raw.strip():
        raise AgentProtocolError("liaison returned no answer contract")
    try:
        answer = LiaisonAnswer.model_validate(json.loads(raw))
        trace = state.get(LIAISON_TRACE_KEY)
        if not isinstance(trace, list):
            raise ValueError("Nova returned no actual tool trace")
        return validate_liaison_answer(answer, trace)
    except (json.JSONDecodeError, ValidationError, ValueError) as exc:
        raise AgentProtocolError(f"invalid liaison output: {exc}") from exc


def _validate_run_output_unwrapped(
    specialist: str, payload: BaseModel, state: dict[str, Any],
) -> None:
    if specialist == "maya_presenter":
        _validated_state(state, "surface_plan", SurfacePlan)
        return
    if specialist == "nova_liaison":
        _validated_liaison_state(state)
        return
    if specialist == "nimi_analyst":
        result = _validated_state(state, "source_analysis", SourceAnalysis)
        validate_source_analysis(AnalystInput.model_validate(payload), result)
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
    if specialist == "noni_copywriter":
        writer_input = CopywriterInput.model_validate(payload)
        draft = _validated_state(state, "copywriter_draft", ContentDraft)
        validate_content_draft(writer_input, draft)
        return
    if specialist == "dara_editor":
        review_input = EditorialReviewInput.model_validate(payload)
        assessment = _validated_state(
            state, "editorial_assessment", EditorialAssessment,
        )
        validate_editorial_assessment(
            review_input.copywriterInput, review_input.draft, assessment,
        )
        return
    raise AgentProtocolError(f"unsupported specialist output: {specialist}")


_AGENT_DISPLAY_NAMES = {
    "nimi_analyst": "Nimi", "ryan_strategist": "Ryan",
    "temi_editorial_planner": "Temi", "noni_copywriter": "Noni",
    "dara_editor": "Dara", "maya_presenter": "Maya", "nova_liaison": "Nova",
}


def _validate_run_output(
    specialist: str, payload: BaseModel, state: dict[str, Any],
) -> None:
    """Expose one stable safe error while retaining the causal validator exception."""
    try:
        _validate_run_output_unwrapped(specialist, payload, state)
    except AgentContractError:
        raise
    except (AgentProtocolError, ValidationError, ValueError, KeyError) as exc:
        display = _AGENT_DISPLAY_NAMES.get(specialist, "Agent")
        raise AgentContractError(
            role=specialist,
            code="invalid_agent_output",
            public_message=f"{display} returned output that did not satisfy its contract.",
            path="output",
        ) from exc


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
    activity_reporter: Callable[[AgentActivityRecord], None] | None = None,
    team_runtime: TeamRuntime | None = None,
) -> dict[str, Any]:
    resolved = _resolve_role_models(model, models)
    roles = _SPECIALIST_ROLES[specialist]
    timeout_seconds = _enforce_role_eligibility(specialist, payload, resolved)
    reserved: list[dict[str, object]] = []
    dispatched = False
    started_at = time.monotonic()
    managed_trace_id = "0" * 32
    managed_span_id = "0" * 16
    input_tokens_total = 0
    output_tokens_total = 0
    inference_calls = 0
    tool_calls = 0
    reporter = activity_reporter
    if reporter is None and team_runtime is None:
        reporter = record_agent_activity

    def emit(records: list[AgentActivityRecord]) -> None:
        if reporter is None:
            return
        for record in records:
            try:
                reporter(record)
            except Exception:  # noqa: BLE001 - observability cannot change workflow outcome
                logger.warning(
                    "agent activity projection failed for operation %s; details suppressed",
                    invocation.operation_id if invocation else "proactive",
                )
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
            span_context = invoke_span.get_span_context()
            if span_context.is_valid:
                managed_span_id = f"{span_context.span_id:016x}"
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
                input_tokens_total += record.input_units if record.unit_type == "tokens" else 0
                output_tokens_total += record.output_units if record.unit_type == "tokens" else 0
                inference_calls += 1
            if specialist == "nova_liaison":
                nova_trace = final_state.get(LIAISON_TRACE_KEY)
                if isinstance(nova_trace, list):
                    data_calls = [item for item in nova_trace if item.get("name") not in {"load_skill", "load_skill_resource"}]
                    tool_calls = len(data_calls)
                    for item in data_calls:
                        response = item.get("response") or {}
                        tool_trace_id = item.get("traceId")
                        tool_span_id = item.get("spanId")
                        if not isinstance(tool_trace_id, str) or tool_trace_id == "0" * 32:
                            continue
                        if not isinstance(tool_span_id, str) or tool_span_id == "0" * 16:
                            continue
                        emit([tool_activity(
                            invocation=invocation,
                            agent=specialist,
                            tool=str(item.get("name")),
                            trace_id=tool_trace_id,
                            span_id=tool_span_id,
                            parent_span_id=managed_span_id,
                            duration_ms=0,
                            status="error" if response.get("status") == "error" else "success",
                        )])
            emit(invocation_activity(
                invocation=invocation,
                agent=specialist,
                model=_instance_model_id(resolved.model_for(specialist)),
                trace_id=managed_trace_id,
                span_id=managed_span_id,
                duration_ms=max(0, round((time.monotonic() - started_at) * 1000)),
                input_tokens=input_tokens_total,
                output_tokens=output_tokens_total,
                inference_calls=inference_calls,
                tool_calls=tool_calls,
            ))
        return final_state
    except Exception as exc:  # noqa: BLE001 - preserve original runtime/provider failure
        if invocation is not None:
            emit(invocation_activity(
                invocation=invocation,
                agent=specialist,
                model=_instance_model_id(resolved.model_for(specialist)),
                trace_id=managed_trace_id,
                span_id=managed_span_id,
                duration_ms=max(0, round((time.monotonic() - started_at) * 1000)),
                input_tokens=input_tokens_total,
                output_tokens=output_tokens_total,
                inference_calls=inference_calls,
                tool_calls=tool_calls,
                error=exc,
            ))
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
) -> SourceAnalysis:
    input = AnalystInput.model_validate(input)
    resolved_memory = configured_memory(invocation) if memory is None else memory
    facts = await _retrieve_memory(query=input.title, memory=resolved_memory)
    if facts:
        input = input.model_copy(update={
            "memoryFacts": [
                *input.memoryFacts,
                *(AnalystMemoryFact(
                    id=f"memory:{fact.evidence_ref.kind}:{fact.evidence_ref.record_id}",
                    kind=fact.kind,
                    content=fact.fact,
                    firestoreEvidenceRef=(
                        f"jobs/{fact.evidence_ref.job_id}/{fact.evidence_ref.kind}/"
                        f"{fact.evidence_ref.record_id}"
                    ),
                ) for fact in facts),
            ][:5],
        })
    if mock_ai_enabled():
        print("[MOCK-AI] coordinator -> nimi_analyst", flush=True)
        raw = mock_analyze(input)
        return validate_source_analysis(
            input, SourceAnalysis.model_validate({k: v for k, v in raw.items() if k != "mock"}),
        )
    state = await _run_coordinator("nimi_analyst", input, invocation=invocation)
    return validate_source_analysis(
        input, _validated_state(state, "source_analysis", SourceAnalysis),
    )


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
    input: CopywriterInput, *, invocation: InvocationContext | None = None,
) -> DraftWorkflowResult:
    input = CopywriterInput.model_validate(input)
    if mock_ai_enabled():
        raise RuntimeError("Noni has no mock production path; inject a TeamRuntime in tests")

    async def noni(writer_input: CopywriterInput, pass_number: int) -> ContentDraft:
        pass_invocation = invocation.model_copy(update={
            "operation_id": f"{invocation.operation_id}:noni:{pass_number}",
        }) if invocation else None
        state = await _run_coordinator("noni_copywriter", writer_input, invocation=pass_invocation)
        draft = _validated_state(state, "copywriter_draft", ContentDraft)
        return validate_content_draft(writer_input, draft)

    async def dara(writer_input: CopywriterInput, draft: ContentDraft, pass_number: int) -> EditorialReview:
        review_input = EditorialReviewInput(copywriterInput=writer_input, draft=draft)
        pass_invocation = invocation.model_copy(update={
            "operation_id": f"{invocation.operation_id}:dara:{pass_number}",
        }) if invocation else None
        state = await _run_coordinator("dara_editor", review_input, invocation=pass_invocation)
        assessment = _validated_state(
            state, "editorial_assessment", EditorialAssessment,
        )
        assessment = validate_editorial_assessment(writer_input, draft, assessment)
        return materialize_editorial_review(
            writer_input, draft, assessment, reviewed_at=datetime.now(timezone.utc),
        )

    original = await noni(input, 1)
    first_review = await dara(input, original, 1)
    if first_review.verdict == "accepted":
        return DraftWorkflowResult(originalDraft=original, reviews=[first_review], revisionDraft=None, acceptedDraft=original)
    revision_input = CopywriterInput.model_validate({
        **input.model_dump(mode="python"), "passType": "revision",
        "priorDraft": original, "priorReview": first_review,
    })
    revision = await noni(revision_input, 2)
    final_review = await dara(revision_input, revision, 2)
    if final_review.verdict != "accepted":
        raise AgentProtocolError("second Dara revise verdict requires operator attention; no third Noni invocation")
    return DraftWorkflowResult(originalDraft=original, reviews=[first_review, final_review], revisionDraft=revision, acceptedDraft=revision)


async def ask_with_team(
    question: str, *, invocation: InvocationContext | None = None,
) -> str:
    """Answer a free-form operator question via the skill-enabled liaison."""
    input = LiaisonInput(question=question)
    if mock_ai_enabled():
        print("[MOCK-AI] coordinator -> nova_liaison", flush=True)
        return mock_ask(input.question)
    state = await _run_coordinator("nova_liaison", input, invocation=invocation)
    return _validated_liaison_state(state).answer


async def ask_with_team_detailed(
    question: str, *, invocation: InvocationContext | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    """Return Nova's answer plus content-free activity derived from its validated trace."""
    input = LiaisonInput(question=question)
    if mock_ai_enabled():
        return mock_ask(input.question), []
    state = await _run_coordinator("nova_liaison", input, invocation=invocation)
    answer = _validated_liaison_state(state)
    trace = state.get(LIAISON_TRACE_KEY) or []
    activity: list[dict[str, Any]] = []
    for entry in trace:
        name = str(entry.get("name") or "unknown_tool")
        response = entry.get("response") or {}
        envelope_error = response.get("error") or {}
        activity.append({
            "sequence": int(entry.get("sequence") or len(activity) + 1),
            "toolName": name,
            "status": "failed" if response.get("status") == "error" else "succeeded",
            **({"code": envelope_error.get("code"), "category": envelope_error.get("category"),
                "publicMessage": envelope_error.get("message"), "retryable": envelope_error.get("retryable")}
               if response.get("status") == "error" else {"publicMessage": f"{name} completed."}),
        })
    return answer.answer, activity
