"""Typed contracts shared by Harmonia's ADK specialists and stage handlers."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Any, Literal
from urllib.parse import urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


Identifier = Annotated[str, Field(min_length=1, max_length=100)]
ConstraintText = Annotated[str, Field(min_length=1, max_length=300)]
AssumptionText = Annotated[str, Field(min_length=1, max_length=500)]


class FrameEvidence(StrictModel):
    id: str = Field(min_length=1)
    uri: str = Field(min_length=1)
    timestamp_sec: float = Field(ge=0)
    digest: str = Field(pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def validate_uri(self) -> "FrameEvidence":
        parsed = urlparse(self.uri)
        if parsed.scheme not in {"https", "gs"}:
            raise ValueError("frame uri must use https or gs")
        return self


class MediaEvidence(StrictModel):
    video_uri: str | None = None
    audio_uri: str | None = None
    duration_sec: float = Field(gt=0)
    source_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    frames: list[FrameEvidence] = Field(default_factory=list, max_length=24)

    @model_validator(mode="after")
    def validate_evidence(self) -> "MediaEvidence":
        if not self.video_uri and not self.audio_uri and not self.frames:
            raise ValueError("media evidence requires video, audio, or frames")
        for uri in (self.video_uri, self.audio_uri):
            if uri is not None and urlparse(uri).scheme not in {"https", "gs"}:
                raise ValueError("media uri must use https or gs")
        frame_ids = [frame.id for frame in self.frames]
        if len(frame_ids) != len(set(frame_ids)):
            raise ValueError("frame ids must be unique")
        if any(frame.timestamp_sec > self.duration_sec for frame in self.frames):
            raise ValueError("frame timestamp exceeds media duration")
        return self


class Moment(StrictModel):
    id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    startSec: float = Field(ge=0)
    endSec: float = Field(ge=0)
    hook: str = Field(min_length=1)
    quote: str = Field(min_length=1)
    visualHook: str | None = Field(default=None, max_length=500)
    cropSuitability: Literal["poor", "fair", "good", "excellent"] | None = None
    captionSafeRegion: str | None = Field(default=None, max_length=200)
    visualEvidenceIds: list[str] = Field(default_factory=list, max_length=12)


class Angle(StrictModel):
    id: str = Field(min_length=1)
    kind: Literal["trend", "meme"]
    title: str = Field(min_length=1)
    rationale: str = Field(min_length=1)


class AnalysisResult(StrictModel):
    summary: str = Field(min_length=1)
    moments: list[Moment] = Field(default_factory=list, max_length=12)
    angles: list[Angle] = Field(default_factory=list, max_length=12)


class AnalystInput(StrictModel):
    title: str = Field(min_length=1)
    channel: str = ""
    transcript: str = Field(min_length=1, max_length=60_000)
    prior_learnings: str = Field(default="", max_length=4_000)
    media_evidence: MediaEvidence | None = None


class AudienceSegment(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=200)
    pains: list[str] = Field(min_length=1, max_length=8)


class CompanyContext(StrictModel):
    evidenceId: str = Field(min_length=1, max_length=100)
    company: str = Field(min_length=1, max_length=200)
    product: str = Field(min_length=1, max_length=500)
    positioning: str = Field(min_length=1, max_length=500)
    differentiators: list[str] = Field(min_length=1, max_length=8)
    brandVoice: list[str] = Field(min_length=1, max_length=8)
    exclusions: list[str] = Field(default_factory=list, max_length=12)
    safetyConstraints: list[str] = Field(default_factory=list, max_length=12)


class CampaignContext(StrictModel):
    evidenceId: str = Field(min_length=1, max_length=100)
    businessObjectives: list[str] = Field(min_length=1, max_length=8)
    campaignObjectives: list[str] = Field(min_length=1, max_length=8)
    audiences: list[AudienceSegment] = Field(min_length=1, max_length=6)
    funnelStage: Literal["awareness", "consideration", "conversion", "retention", "advocacy"]
    intendedConversion: str = Field(min_length=1, max_length=300)
    requestedChannels: list[str] = Field(min_length=1, max_length=8)
    supportedChannels: list[str] = Field(min_length=1, max_length=8)
    horizonWeeks: int = Field(default=4, ge=1, le=12)


class PerformanceObservation(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    summary: str = Field(min_length=1, max_length=600)
    firestoreEvidenceRef: str = Field(min_length=1, max_length=500)


class MemoryFact(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    content: str = Field(min_length=1, max_length=600)
    firestoreEvidenceRef: str = Field(min_length=1, max_length=500)


class StrategistInput(StrictModel):
    source_title: str = Field(min_length=1, max_length=300)
    company: CompanyContext
    campaign: CampaignContext
    analysis: AnalysisResult
    performance: list[PerformanceObservation] = Field(default_factory=list, max_length=12)
    memoryFacts: list[MemoryFact] = Field(default_factory=list, max_length=5)
    revision: int = Field(default=1, ge=1, le=2)
    revisionFeedback: str | None = Field(default=None, max_length=2_000)

    @model_validator(mode="after")
    def validate_revision(self) -> "StrategistInput":
        if self.revision == 2 and not (self.revisionFeedback or "").strip():
            raise ValueError("strategy revision feedback is required")
        return self


class EvidenceClaim(StrictModel):
    text: str = Field(min_length=1, max_length=600)
    evidenceRefs: list[str] = Field(min_length=1, max_length=12)


class AudiencePriority(StrictModel):
    audienceId: str = Field(min_length=1, max_length=100)
    priority: int = Field(ge=1, le=5)
    reason: str = Field(min_length=1, max_length=500)
    evidenceRefs: list[str] = Field(min_length=1, max_length=12)


class StrategicPillar(StrictModel):
    name: str = Field(min_length=1, max_length=200)
    purpose: str = Field(min_length=1, max_length=500)
    evidenceRefs: list[str] = Field(min_length=1, max_length=12)


class CampaignTheme(StrictModel):
    name: str = Field(min_length=1, max_length=200)
    message: str = Field(min_length=1, max_length=500)
    evidenceRefs: list[str] = Field(min_length=1, max_length=12)


class ChannelRole(StrictModel):
    channel: str = Field(min_length=1, max_length=100)
    role: str = Field(min_length=1, max_length=300)
    operationallySupported: bool
    formats: list[str] = Field(min_length=1, max_length=8)
    cadence: str = Field(min_length=1, max_length=200)
    evidenceRefs: list[str] = Field(min_length=1, max_length=12)


class ContentMixItem(StrictModel):
    format: str = Field(min_length=1, max_length=100)
    percentage: int = Field(ge=1, le=100)


class StrategyKpi(StrictModel):
    name: str = Field(min_length=1, max_length=200)
    target: str = Field(min_length=1, max_length=200)
    measurement: str = Field(min_length=1, max_length=300)
    evidenceRefs: list[str] = Field(min_length=1, max_length=12)


class StrategyAssumption(StrictModel):
    text: str = Field(min_length=1, max_length=500)
    evidenceRefs: list[str] = Field(min_length=1, max_length=12)
    confidence: Literal["low", "medium", "high"]


class ContentBrief(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=300)
    objective: str = Field(min_length=1, max_length=600)
    audienceId: str = Field(min_length=1, max_length=100)
    funnelStage: Literal["awareness", "consideration", "conversion", "retention", "advocacy"]
    keyMessage: str = Field(min_length=1, max_length=600)
    channelCandidates: list[str] = Field(min_length=1, max_length=8)
    formatCandidates: list[str] = Field(min_length=1, max_length=8)
    ctaIntent: str = Field(min_length=1, max_length=300)
    intendedConversion: str = Field(min_length=1, max_length=300)
    kpi: str = Field(min_length=1, max_length=200)
    priority: int = Field(ge=1, le=5)
    dependencies: list[str] = Field(default_factory=list, max_length=8)
    constraints: list[str] = Field(default_factory=list, max_length=12)
    evidenceRefs: list[str] = Field(min_length=1, max_length=12)


class ContentStrategy(StrictModel):
    strategyId: str = Field(min_length=1, max_length=100)
    version: int = Field(ge=1, le=2)
    horizonWeeks: int = Field(ge=1, le=12)
    thesis: str = Field(min_length=1, max_length=600)
    differentiatedNarrative: str = Field(min_length=1, max_length=600)
    objectives: list[EvidenceClaim] = Field(min_length=1, max_length=8)
    audiencePriorities: list[AudiencePriority] = Field(min_length=1, max_length=6)
    funnelIntent: Literal["awareness", "consideration", "conversion", "retention", "advocacy"]
    intendedConversions: list[str] = Field(min_length=1, max_length=6)
    pillars: list[StrategicPillar] = Field(min_length=1, max_length=8)
    campaignThemes: list[CampaignTheme] = Field(min_length=1, max_length=8)
    channelRoles: list[ChannelRole] = Field(min_length=1, max_length=8)
    contentMix: list[ContentMixItem] = Field(min_length=1, max_length=8)
    cadenceGuidance: str = Field(min_length=1, max_length=300)
    priorityRules: list[str] = Field(min_length=1, max_length=8)
    ctaGuidance: list[str] = Field(min_length=1, max_length=8)
    kpis: list[StrategyKpi] = Field(min_length=1, max_length=8)
    successCriteria: list[str] = Field(min_length=1, max_length=8)
    constraints: list[str] = Field(default_factory=list, max_length=12)
    exclusions: list[str] = Field(default_factory=list, max_length=12)
    brandSafety: list[str] = Field(default_factory=list, max_length=12)
    briefs: list[ContentBrief] = Field(min_length=1, max_length=10)
    assumptions: list[StrategyAssumption] = Field(default_factory=list, max_length=8)
    confidence: Literal["low", "medium", "high"]

    @model_validator(mode="after")
    def validate_mix(self) -> "ContentStrategy":
        if sum(item.percentage for item in self.contentMix) != 100:
            raise ValueError("content mix percentages must total 100")
        return self


class StrategistResult(StrictModel):
    strategy: ContentStrategy


class Draft(StrictModel):
    id: str = Field(min_length=1)
    platform: Literal["x"]
    momentId: str | None = None
    angleId: str | None = None
    text: str = Field(min_length=1, max_length=280)


class DraftSet(StrictModel):
    drafts: list[Draft] = Field(default_factory=list, max_length=10)


def _validate_utc_timestamp(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() != timezone.utc.utcoffset(value):
        raise ValueError("timestamp must be UTC")
    return value


def _validate_iana_timezone(value: str) -> str:
    try:
        ZoneInfo(value)
    except ZoneInfoNotFoundError as exc:
        raise ValueError("timezone must be a valid IANA timezone") from exc
    return value


class StrategyApprovalRecord(StrictModel):
    decision: Literal["approved"]
    payloadDigest: str = Field(pattern=r"^[0-9a-f]{64}$")
    revision: int = Field(ge=1, le=2)
    actorSubjectId: str = Field(min_length=1, max_length=200)
    decidedAt: datetime
    expiresAt: datetime
    feedback: str | None = Field(default=None, max_length=2_000)

    @field_validator("decidedAt", "expiresAt")
    @classmethod
    def validate_utc_timestamp(cls, value: datetime) -> datetime:
        return _validate_utc_timestamp(value)


class ChannelCapability(StrictModel):
    channel: str = Field(min_length=1, max_length=100)
    formats: list[Identifier] = Field(min_length=1, max_length=8)


class EditorialCommitment(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    channel: str = Field(min_length=1, max_length=100)
    publicationWindowStartAt: datetime
    publicationWindowEndAt: datetime

    @field_validator("publicationWindowStartAt", "publicationWindowEndAt")
    @classmethod
    def validate_utc_timestamp(cls, value: datetime) -> datetime:
        return _validate_utc_timestamp(value)

    @model_validator(mode="after")
    def validate_window(self) -> "EditorialCommitment":
        if self.publicationWindowStartAt >= self.publicationWindowEndAt:
            raise ValueError("publication window must increase")
        return self


class ProductionCapacity(StrictModel):
    maxItems: int = Field(ge=1, le=48)
    maxItemsPerWeek: int = Field(ge=1, le=12)


class CadenceConstraints(StrictModel):
    minimumHoursBetweenItems: int = Field(ge=0, le=168)
    maxItemsPerChannelPerWeek: int = Field(ge=1, le=12)


class PostingWindowObservation(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    channel: str = Field(min_length=1, max_length=100)
    format: str = Field(min_length=1, max_length=100)
    observedAt: datetime
    evidenceRefs: list[Identifier] = Field(min_length=1, max_length=12)

    @field_validator("observedAt")
    @classmethod
    def validate_utc_timestamp(cls, value: datetime) -> datetime:
        return _validate_utc_timestamp(value)


class EditorialPlannerInput(StrictModel):
    strategy: ContentStrategy
    strategyDigest: str = Field(pattern=r"^[0-9a-f]{64}$")
    strategyVersion: int = Field(ge=1, le=2)
    strategyApproval: StrategyApprovalRecord
    analysis: AnalysisResult
    horizonStartAt: datetime
    horizonEndAt: datetime
    timezone: str = Field(min_length=1, max_length=100)
    channelCapabilities: list[ChannelCapability] = Field(min_length=1, max_length=8)
    existingCommitments: list[EditorialCommitment] = Field(default_factory=list, max_length=48)
    productionCapacity: ProductionCapacity
    cadenceConstraints: CadenceConstraints
    postingWindowObservations: list[PostingWindowObservation] = Field(default_factory=list, max_length=24)
    revision: int = Field(ge=1, le=2)
    replanningFeedback: str | None = Field(default=None, max_length=2_000)

    @field_validator("horizonStartAt", "horizonEndAt")
    @classmethod
    def validate_utc_timestamp(cls, value: datetime) -> datetime:
        return _validate_utc_timestamp(value)

    @field_validator("timezone")
    @classmethod
    def validate_timezone(cls, value: str) -> str:
        return _validate_iana_timezone(value)

    @model_validator(mode="after")
    def validate_horizon(self) -> "EditorialPlannerInput":
        if self.horizonStartAt >= self.horizonEndAt:
            raise ValueError("editorial horizon must increase")
        return self


class EditorialPlanItem(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    briefId: str = Field(min_length=1, max_length=100)
    campaignTheme: str = Field(min_length=1, max_length=200)
    contentPillar: str = Field(min_length=1, max_length=200)
    objective: str = Field(min_length=1, max_length=600)
    audienceId: str = Field(min_length=1, max_length=100)
    funnelStage: Literal["awareness", "consideration", "conversion", "retention", "advocacy"]
    intendedConversion: str = Field(min_length=1, max_length=300)
    ctaIntent: str = Field(min_length=1, max_length=300)
    kpi: str = Field(min_length=1, max_length=200)
    channel: str = Field(min_length=1, max_length=100)
    format: str = Field(min_length=1, max_length=100)
    evidenceRefs: list[Identifier] = Field(min_length=1, max_length=12)
    publicationWindowStartAt: datetime
    publicationWindowEndAt: datetime
    productionDeadlineAt: datetime
    priority: int = Field(ge=1, le=5)
    selectionScore: float = Field(ge=0, le=1)
    dependencies: list[Identifier] = Field(default_factory=list, max_length=8)
    productionStatus: Literal["planned"]
    constraints: list[ConstraintText] = Field(default_factory=list, max_length=12)
    requiredAssets: list[ConstraintText] = Field(default_factory=list, max_length=12)
    planningRationale: str = Field(min_length=1, max_length=600)
    selectionRationale: str = Field(min_length=1, max_length=600)
    confidence: Literal["low", "medium", "high"]

    @field_validator("publicationWindowStartAt", "publicationWindowEndAt", "productionDeadlineAt")
    @classmethod
    def validate_utc_timestamp(cls, value: datetime) -> datetime:
        return _validate_utc_timestamp(value)

    @model_validator(mode="after")
    def validate_timing(self) -> "EditorialPlanItem":
        if self.publicationWindowStartAt >= self.publicationWindowEndAt:
            raise ValueError("publication window must increase")
        if self.productionDeadlineAt > self.publicationWindowStartAt:
            raise ValueError("production deadline must be before the publication window")
        return self


class EditorialPlan(StrictModel):
    planId: str = Field(min_length=1, max_length=100)
    version: int = Field(ge=1, le=2)
    approvedStrategyDigest: str = Field(pattern=r"^[0-9a-f]{64}$")
    horizonStartAt: datetime
    horizonEndAt: datetime
    timezone: str = Field(min_length=1, max_length=100)
    summary: str = Field(min_length=1, max_length=1_000)
    sequencingRationale: str = Field(min_length=1, max_length=1_000)
    cadenceRationale: str = Field(min_length=1, max_length=1_000)
    assumptions: list[AssumptionText] = Field(default_factory=list, max_length=12)
    confidence: Literal["low", "medium", "high"]
    items: list[EditorialPlanItem] = Field(min_length=1, max_length=48)
    selectedNextItemId: str = Field(min_length=1, max_length=100)

    @field_validator("horizonStartAt", "horizonEndAt")
    @classmethod
    def validate_utc_timestamp(cls, value: datetime) -> datetime:
        return _validate_utc_timestamp(value)

    @field_validator("timezone")
    @classmethod
    def validate_timezone(cls, value: str) -> str:
        return _validate_iana_timezone(value)

    @model_validator(mode="after")
    def validate_horizon_and_selection(self) -> "EditorialPlan":
        if self.horizonStartAt >= self.horizonEndAt:
            raise ValueError("editorial horizon must increase")
        selected = [item for item in self.items if item.id == self.selectedNextItemId]
        if len(selected) != 1:
            raise ValueError("selectedNextItemId must identify exactly one plan item")
        return self


class ProductionDraftInput(StrictModel):
    planId: str = Field(min_length=1, max_length=100)
    strategyDigest: str = Field(pattern=r"^[0-9a-f]{64}$")
    editorialItem: EditorialPlanItem
    brief: ContentBrief
    referencedMoments: list[Moment] = Field(default_factory=list, max_length=12)
    referencedAngles: list[Angle] = Field(default_factory=list, max_length=12)
    brandContext: str = Field(min_length=1, max_length=4_000)
    constraints: list[ConstraintText] = Field(default_factory=list, max_length=24)

    @model_validator(mode="after")
    def validate_selected_authority(self) -> "ProductionDraftInput":
        if self.brief.id != self.editorialItem.briefId:
            raise ValueError("production input must contain the exact selected brief")
        exact_fields = (
            "objective", "audienceId", "funnelStage", "intendedConversion",
            "ctaIntent", "kpi",
        )
        if any(getattr(self.brief, field) != getattr(self.editorialItem, field) for field in exact_fields):
            raise ValueError("production input brief does not match the selected editorial item")
        if set(self.brief.evidenceRefs) != set(self.editorialItem.evidenceRefs):
            raise ValueError("production input brief evidence does not match the selected editorial item")
        supplied_ids = {item.id for item in [*self.referencedMoments, *self.referencedAngles]}
        if not supplied_ids or not supplied_ids.issubset(set(self.editorialItem.evidenceRefs)):
            raise ValueError("production input contains unreferenced evidence")
        return self


class PublishAction(StrictModel):
    type: Literal["publish_x_post"] = "publish_x_post"
    text: str = Field(min_length=1, max_length=280)


class ActionPlan(StrictModel):
    actions: list[PublishAction] = Field(default_factory=list, max_length=10)


class DraftWorkflowResult(StrictModel):
    copywriter_drafts: DraftSet
    reviewed_drafts: DraftSet
    action_plan: ActionPlan

    @model_validator(mode="after")
    def validate_review_and_plan(self) -> "DraftWorkflowResult":
        originals = {draft.id: draft for draft in self.copywriter_drafts.drafts}
        reviewed_ids: set[str] = set()
        for draft in self.reviewed_drafts.drafts:
            original = originals.get(draft.id)
            if original is None:
                raise ValueError("editor must preserve draft id")
            if (draft.momentId, draft.angleId) != (original.momentId, original.angleId):
                raise ValueError("editor must preserve source references")
            reviewed_ids.add(draft.id)
        if len(reviewed_ids) != len(self.reviewed_drafts.drafts):
            raise ValueError("editor returned duplicate draft ids")

        reviewed_text = {draft.text for draft in self.reviewed_drafts.drafts}
        if any(action.text not in reviewed_text for action in self.action_plan.actions):
            raise ValueError("planner actions must use reviewed draft text")
        return self


class LiaisonInput(StrictModel):
    """Operator question routed to the skill-enabled insight liaison."""

    question: str = Field(min_length=1, max_length=2000)


def validate_draft_references(drafts: DraftSet, analysis: AnalysisResult) -> DraftSet:
    """Reject draft references that are not present in the current analysis."""
    moment_ids = {moment.id for moment in analysis.moments}
    angle_ids = {angle.id for angle in analysis.angles}
    for draft in drafts.drafts:
        if draft.momentId is not None and draft.momentId not in moment_ids:
            raise ValueError(f"unknown momentId: {draft.momentId}")
        if draft.angleId is not None and draft.angleId not in angle_ids:
            raise ValueError(f"unknown angleId: {draft.angleId}")
    return drafts
