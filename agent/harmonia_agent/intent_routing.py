"""Strict, skill-owned routing for natural Harmonia operator requests."""

from __future__ import annotations

import pathlib
import re
from typing import Literal

from pydantic import ConfigDict, Field, StrictBool, StrictInt, StrictStr, model_validator

from .agent_models import AudienceSegment, StrategyResearchRequest, StrictModel
from . import web_client
from .tool_contracts import evidence, provider_error, success

SKILL_DIR = pathlib.Path(__file__).parent / "skills" / "harmonia-intent-routing"
CONTEXT_SKILL_DIR = pathlib.Path(__file__).parent / "skills" / "harmonia-context-assembly"

IntentName = Literal[
    "establish_strategy", "revise_strategy", "advance_plan", "manage_calendar", "append_deliverable",
    "repurpose_source", "one_off_content", "status_evidence", "effect_request",
    "conversation",
]
OutputConcept = Literal[
    "short_social_post", "social_thread", "professional_post", "article",
    "newsletter", "caption", "carousel", "social_image", "quote_card",
    "diagram", "short_video", "generated_video", "generated_music",
    "calendar", "content_package",
]
SocialPlatform = Literal["x", "linkedin", "linkedin-organization", "instagram", "tiktok"]


def get_social_platform_connections() -> dict:
    """Read safe connection state for Harmonia's supported social platforms."""
    try:
        connections = [item for item in web_client.get_platform_connections() if item.get("id") in {"x", "linkedin", "linkedin-organization", "instagram", "tiktok"}]
        return success(
            {"platforms": connections},
            evidence_items=[evidence("harmonia_platform_connections", provenance="live")],
        )
    except Exception as exc:  # noqa: BLE001 - normalized tool boundary
        return provider_error(exc)


class RecentJobSummary(StrictModel):
    id: StrictStr = Field(min_length=1, max_length=128)
    stage: StrictStr = Field(min_length=1, max_length=64)
    status: StrictStr = Field(min_length=1, max_length=64)
    title: StrictStr | None = Field(default=None, max_length=2_000)


class StrategyReference(StrictModel):
    thesis: StrictStr = Field(min_length=1, max_length=2_000)
    strategyId: StrictStr = Field(min_length=1, max_length=200)
    revision: StrictInt = Field(ge=1)
    digest: StrictStr = Field(min_length=64, max_length=64)


class PlannedItemStrategyReference(StrictModel):
    """The item pins an immutable strategy ref; it is not the active-strategy summary."""
    strategyId: StrictStr = Field(min_length=1, max_length=200)
    revision: StrictInt = Field(ge=1)
    digest: StrictStr = Field(min_length=64, max_length=64)


class OperationProposal(StrictModel):
    id: StrictStr = Field(min_length=1, max_length=200)
    kind: Literal["content", "strategy", "learning_strategy", "incomplete_command", "source_replacement", "strategy_rebase", "calendar_change", "measurement_change"]
    status: StrictStr = Field(min_length=1, max_length=100)
    changes: list[StrictStr] = Field(default_factory=list)
    evidenceRefs: list[StrictStr] = Field(default_factory=list, max_length=12_168)
    revision: StrictInt | None = Field(default=None, ge=1)
    decision: StrictStr | None = Field(default=None, max_length=2_000)


class OperationCampaign(StrictModel):
    id: StrictStr = Field(min_length=1, max_length=200)
    name: StrictStr = Field(min_length=1, max_length=300)
    objective: StrictStr = Field(min_length=1, max_length=1_000)


class OperationPlan(StrictModel):
    id: StrictStr = Field(min_length=1, max_length=200)
    revision: StrictInt = Field(ge=1)
    reason: StrictStr = Field(min_length=1, max_length=1_000)


class OperationPlannedItem(StrictModel):
    id: StrictStr = Field(min_length=1, max_length=200)
    planId: StrictStr = Field(min_length=1, max_length=200)
    campaignId: StrictStr | None = Field(default=None, max_length=200)
    campaignLabel: StrictStr = Field(min_length=1, max_length=300)
    name: StrictStr = Field(min_length=1, max_length=500)
    objective: StrictStr = Field(min_length=1, max_length=1_000)
    channel: StrictStr = Field(min_length=1, max_length=100)
    scheduledFor: StrictStr = Field(min_length=1, max_length=100)
    strategyRef: PlannedItemStrategyReference
    metricIds: list[StrictStr] = Field(default_factory=list, max_length=8)
    sourceEvidenceRefs: list[StrictStr] = Field(default_factory=list, max_length=12_168)
    declaredDependencies: list[StrictStr] = Field(default_factory=list)
    requiredAssets: list[StrictStr] = Field(default_factory=list)
    evidenceState: Literal["source_backed", "operator_context", "unavailable"]
    approvalState: Literal["pending", "not_pending"]
    lifecycleState: Literal["planned", "running", "awaiting_approval", "completed", "failed", "cancelled", "blocked", "requires_disposition"]
    unresolvedDependencies: list[StrictStr] = Field(default_factory=list)


class OperationResult(StrictModel):
    id: StrictStr = Field(min_length=1, max_length=200)
    metric: StrictStr = Field(min_length=1, max_length=1_000)
    availability: Literal["available", "pending", "pending_window", "stale", "revoked", "unavailable", "failed"]
    checkedAt: StrictStr | None = Field(default=None, max_length=100)


class WorkspaceOperationContext(StrictModel):
    """Exact read-only TypeScript operation projection; routing cannot mutate it."""
    activeStrategy: StrategyReference | None = None
    proposedChanges: list[OperationProposal] = Field(default_factory=list)
    campaigns: list[OperationCampaign] = Field(default_factory=list)
    plans: list[OperationPlan] = Field(default_factory=list)
    plannedItems: list[OperationPlannedItem] = Field(default_factory=list)
    results: list[OperationResult] = Field(default_factory=list)
    currentJobs: list[RecentJobSummary] = Field(default_factory=list)


class WorkspaceContentContext(StrictModel):
    strategyReady: StrictBool
    planReady: StrictBool
    calendarReady: StrictBool
    pendingApprovalCount: StrictInt = Field(ge=0, le=1000)
    goals: list[StrictStr] = Field(max_length=12)
    channels: list[StrictStr] = Field(max_length=12)
    strategySummary: StrictStr | None = Field(default=None, max_length=1000)
    planSummary: StrictStr | None = Field(default=None, max_length=1000)
    upcomingItemCount: StrictInt = Field(default=0, ge=0, le=1000)
    recentJobs: list[RecentJobSummary] = Field(default_factory=list)
    operation: WorkspaceOperationContext | None = None


class ConversationTurn(StrictModel):
    role: Literal["user", "assistant"]
    text: StrictStr = Field(min_length=1, max_length=2000)


IntakeMissingField = Literal["expectedOutcome", "target", "rights", "requestedOutputs", "sources", "strategyContext", "activeStrategy"]


class IntakeClarification(StrictModel):
    field: IntakeMissingField
    question: StrictStr = Field(min_length=1, max_length=300)


class IntentRoutingInput(StrictModel):
    message: StrictStr = Field(min_length=1, max_length=2000)
    workspaceContext: WorkspaceContentContext
    attachmentCount: StrictInt = Field(ge=0, le=10)
    recentConversation: list[ConversationTurn] = Field(default_factory=list, max_length=8)
    pendingClarification: IntakeClarification | None = None
    pendingSourceUrls: list[StrictStr] = Field(default_factory=list, max_length=10)


def source_urls_from_input(value: IntentRoutingInput) -> list[str]:
    """Source authority comes from this message and the host's pending draft only."""
    urls: list[str] = list(dict.fromkeys(value.pendingSourceUrls))
    for text in [value.message]:
        for match in re.findall(r"https?://[^\s<>\"']+", text):
            url = match.rstrip(".,;:!?)]}")
            if url and url not in urls:
                urls.append(url)
    return urls


def deterministic_intent_classification(
    value: IntentRoutingInput,
) -> IntentClassification | None:
    """Classify syntax that carries no model judgment; return None when ambiguous."""
    urls = source_urls_from_input(value)
    message = value.message.casefold()
    append_requested = (
        re.search(r"\b(?:add|append|schedule)\b", message)
        and re.search(r"\b(?:campaign|plan)\b", message)
        and re.search(r"\b(?:post|thread|article|newsletter|caption|carousel|image|video|music|deliverable)\b", message)
    )
    if append_requested:
        target = re.search(r"\b(?:campaign|plan)\s+[\"“]([^\"”]+)[\"”]", value.message, re.IGNORECASE)
        name = re.search(r"\b(?:called|named)\s+[\"“]([^\"”]+)[\"”]", value.message, re.IGNORECASE)
        timestamp = re.search(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})", value.message)
        outputs: list[OutputConcept] = []
        platforms: list[SocialPlatform] = []
        if re.search(r"\b(?:x|twitter)\s+(?:post|thread)\b", message):
            outputs.append("social_thread" if "thread" in message else "short_social_post")
            platforms.append("x")
        if re.search(r"\blinkedin\s+(?:post|article)\b", message):
            outputs.append("article" if "article" in message else "professional_post")
            platforms.append("linkedin")
        if target and name and timestamp and outputs:
            return IntentClassification(
                intent="append_deliverable", workPlacement="existing_plan_item",
                targetName=target.group(1).strip(), deliverableName=name.group(1).strip(),
                scheduledFor=timestamp.group(0), dependencyItemIds=[], requiredAssetIds=[],
                userOutcome=f"Add {name.group(1).strip()}", sourceUrls=[],
                outputConcepts=outputs, platformRecommendations=platforms,
                assumptions=[], needsClarification=False, clarifyingQuestion=None,
                requiresRightsAttestation=False, effectRequested=False, jobId=None,
            )
    if value.pendingClarification or re.search(r"\b(?:campaign|initiative|knowledge|planned|plan item)\b", message):
        return None
    if not urls and re.search(r"\b(?:create|make|generate|produce|draft|prepare)\b", message):
        outputs: list[OutputConcept] = []
        if re.search(r"\b(?:social\s+)?(?:image|visual|graphic)\b", message):
            outputs.append("social_image")
        if re.search(r"\b(?:(?:generated\s+|text[-\s]to[-\s])?video)\b", message):
            outputs.append("generated_video")
        if re.search(r"\b(?:instrumental\s+)?(?:music|soundtrack)\b", message):
            outputs.append("generated_music")
        if outputs:
            return IntentClassification(
                intent="one_off_content",
                workPlacement="independent",
                userOutcome="Create the exact requested media outputs for operator review.",
                sourceUrls=[],
                outputConcepts=outputs,
                platformRecommendations=[],
                assumptions=[],
                needsClarification=False,
                clarifyingQuestion=None,
                requiresRightsAttestation=False,
                effectRequested=False,
                jobId=None,
            )
    if urls and re.search(
        r"\b(?:repurpose|transcribe|analy[sz]e|clip|turn|transform|convert)\b",
        message,
    ):
        platforms: list[SocialPlatform] = []
        for platform, markers in (
            ("linkedin", ("linkedin",)),
            ("instagram", ("instagram",)),
            ("tiktok", ("tiktok", "tik tok")),
            ("x", (" twitter", " x ")),
        ):
            if any(marker in f" {message} " for marker in markers):
                platforms.append(platform)  # type: ignore[arg-type]
        outputs: list[OutputConcept] = []
        if "linkedin" in platforms:
            outputs.append("professional_post")
        if re.search(r"\b(?:content package|content pack|exportable)\b", message):
            outputs.append("content_package")
        if re.search(r"\b(?:short video|short clip|video clip)\b", message):
            outputs.append("short_video")
        if not outputs:
            return None
        return IntentClassification(
            intent="repurpose_source",
            workPlacement="independent",
            userOutcome="Repurpose the supplied source into the requested content.",
            sourceUrls=urls,
            outputConcepts=outputs,
            platformRecommendations=platforms,
            assumptions=[],
            needsClarification=False,
            clarifyingQuestion=None,
            requiresRightsAttestation=any(
                "youtube.com" in url or "youtu.be" in url for url in urls
            ),
            effectRequested=False,
            jobId=None,
        )
    return None


class IntentStrategyContext(StrictModel):
    company: StrictStr = Field(min_length=1, max_length=200)
    product: StrictStr = Field(min_length=1, max_length=500)
    positioning: StrictStr = Field(min_length=1, max_length=500)
    differentiators: list[StrictStr] = Field(min_length=1, max_length=8)
    brandVoice: list[StrictStr] = Field(min_length=1, max_length=8)
    exclusions: list[StrictStr] = Field(default_factory=list, max_length=12)
    safetyConstraints: list[StrictStr] = Field(default_factory=list, max_length=12)
    businessObjectives: list[StrictStr] = Field(min_length=1, max_length=8)
    campaignObjectives: list[StrictStr] = Field(min_length=1, max_length=8)
    audiences: list[AudienceSegment] = Field(min_length=1, max_length=6)
    funnelStage: Literal["awareness", "consideration", "conversion", "retention", "advocacy"]
    intendedConversion: StrictStr = Field(min_length=1, max_length=300)
    requestedChannels: list[StrictStr] = Field(min_length=1, max_length=8)
    supportedChannels: list[StrictStr] = Field(min_length=1, max_length=8)
    horizonWeeks: StrictInt = Field(default=4, ge=1, le=12)
    researchRequest: StrategyResearchRequest | None = None


class IntentClassification(StrictModel):
    """Small routing contract; strategy assembly is a separate bounded delegation."""

    intent: IntentName
    workPlacement: Literal["independent", "existing_plan_item", "new_initiative", "knowledge_only"] | None = None
    targetName: StrictStr | None = Field(default=None, max_length=200)
    deliverableName: StrictStr | None = Field(default=None, max_length=500)
    scheduledFor: StrictStr | None = Field(default=None, max_length=100)
    dependencyItemIds: list[StrictStr] = Field(default_factory=list, max_length=32)
    requiredAssetIds: list[StrictStr] = Field(default_factory=list, max_length=32)
    userOutcome: StrictStr = Field(min_length=1, max_length=500)
    sourceUrls: list[StrictStr] = Field(max_length=10)
    outputConcepts: list[OutputConcept] = Field(max_length=8)
    platformRecommendations: list[SocialPlatform] = Field(max_length=5)
    assumptions: list[StrictStr] = Field(max_length=8)
    missingField: IntakeMissingField | None = None
    resolvedField: IntakeMissingField | None = None
    needsClarification: StrictBool
    clarifyingQuestion: StrictStr | None = Field(default=None, max_length=300)
    requiresRightsAttestation: StrictBool
    effectRequested: StrictBool
    jobId: StrictStr | None = Field(default=None, max_length=128)

    @model_validator(mode="after")
    def enforce_question_shape(self) -> "IntentClassification":
        if self.effectRequested != (self.intent == "effect_request"):
            raise ValueError("effectRequested must match the effect_request intent")
        if self.needsClarification != bool(self.clarifyingQuestion) or self.needsClarification != bool(self.missingField):
            raise ValueError("clarifyingQuestion must match needsClarification")
        if self.intent == "append_deliverable" and not self.needsClarification:
            if self.workPlacement != "existing_plan_item" or not self.targetName or not self.deliverableName or not self.scheduledFor or not re.search(r"(?:Z|[+-]\d{2}:\d{2})$", self.scheduledFor) or not self.outputConcepts:
                raise ValueError("complete append deliverable constraints required")
        return self


class StrategyContextAssemblyInput(StrictModel):
    message: StrictStr = Field(min_length=1, max_length=2000)
    recentConversation: list[ConversationTurn] = Field(default_factory=list, max_length=8)
    userOutcome: StrictStr = Field(min_length=1, max_length=500)
    sourceUrls: list[StrictStr] = Field(max_length=10)
    outputConcepts: list[OutputConcept] = Field(max_length=8)
    requestedChannels: list[SocialPlatform] = Field(max_length=5)


class IntentRoute(StrictModel):
    model_config = ConfigDict(extra="forbid")

    intent: IntentName
    workPlacement: Literal["independent", "existing_plan_item", "new_initiative", "knowledge_only"] | None = None
    targetName: StrictStr | None = Field(default=None, max_length=200)
    deliverableName: StrictStr | None = Field(default=None, max_length=500)
    scheduledFor: StrictStr | None = Field(default=None, max_length=100)
    dependencyItemIds: list[StrictStr] = Field(default_factory=list, max_length=32)
    requiredAssetIds: list[StrictStr] = Field(default_factory=list, max_length=32)
    userOutcome: StrictStr = Field(min_length=1, max_length=500)
    sourceUrls: list[StrictStr] = Field(max_length=10)
    outputConcepts: list[OutputConcept] = Field(max_length=8)
    platformRecommendations: list[SocialPlatform] = Field(max_length=5)
    connectionSuggestions: list[SocialPlatform] = Field(max_length=5)
    assumptions: list[StrictStr] = Field(max_length=8)
    missingField: IntakeMissingField | None = None
    resolvedField: IntakeMissingField | None = None
    needsClarification: StrictBool
    clarifyingQuestion: StrictStr | None = Field(default=None, max_length=300)
    requiresRightsAttestation: StrictBool
    effectRequested: StrictBool
    effectAuthorized: StrictBool = False
    jobId: StrictStr | None = Field(default=None, max_length=128)
    strategyContext: IntentStrategyContext | None = None

    @model_validator(mode="after")
    def enforce_authority_and_question_shape(self) -> "IntentRoute":
        if self.effectAuthorized:
            raise ValueError("intent routing cannot authorize an external effect")
        if self.effectRequested != (self.intent == "effect_request"):
            raise ValueError("effectRequested must match the effect_request intent")
        if self.needsClarification != bool(self.clarifyingQuestion) or self.needsClarification != bool(self.missingField):
            raise ValueError("clarifyingQuestion must match needsClarification")
        if self.intent == "append_deliverable" and not self.needsClarification:
            if self.workPlacement != "existing_plan_item" or not self.targetName or not self.deliverableName or not self.scheduledFor or not re.search(r"(?:Z|[+-]\d{2}:\d{2})$", self.scheduledFor) or not self.outputConcepts:
                raise ValueError("complete append deliverable constraints required")
        if not set(self.connectionSuggestions).issubset(self.platformRecommendations):
            raise ValueError("connection suggestions must be recommended platforms")
        if re.search(
            r"\b(?:has|have|had|was|were)\s+(?:successfully\s+|already\s+)?"
            r"(?:accepted|extracted|parsed|prepared|repurposed|completed|published|verified|executed)\b"
            r"|\bsuccessfully\s+(?:accepted|extracted|parsed|prepared|repurposed|completed|published|verified|executed)\b",
            self.userOutcome.casefold(),
        ):
            raise ValueError("userOutcome must describe the desired future outcome, not claim completed work")
        if (
            self.intent in {"establish_strategy", "revise_strategy"}
            and not self.needsClarification
            and self.strategyContext is None
        ):
            raise ValueError("strategy context is required before starting a strategy job")
        return self






def compiled_intent_routing_skill_context() -> str:
    """Compile Harmonia's owned routing skill for a one-response typed handoff."""
    instructions = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
    return (
        "# Coordinator-compiled Harmonia intent-routing skill\n"
        "Activation: coordinator_compiled\n"
        "The immutable skill below is already loaded. Do not request or load it again.\n\n"
        f"{instructions.strip()}"
    )


def compiled_context_assembly_skill_context() -> str:
    """Compile Harmonia's narrow context-assembly skill for one typed response."""
    return "PRELOADED context assembly skill; do not call removed loaders.\n" + (CONTEXT_SKILL_DIR / "SKILL.md").read_text()
