"""Typed contracts shared by Harmonia's ADK specialists and stage handlers."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Annotated, Any, Callable, Literal
from urllib.parse import urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


Identifier = Annotated[str, Field(min_length=1, max_length=100)]
ConstraintText = Annotated[str, Field(min_length=1, max_length=300)]
AssumptionText = Annotated[str, Field(min_length=1, max_length=500)]
StrictIdentifier = Annotated[StrictStr, Field(min_length=1, max_length=100)]
StrictConstraintText = Annotated[StrictStr, Field(min_length=1, max_length=300)]
StrictAssumptionText = Annotated[StrictStr, Field(min_length=1, max_length=500)]
StrictDigest = Annotated[StrictStr, Field(pattern=r"^[0-9a-f]{64}$")]


def _require_json_list(value: object) -> object:
    if not isinstance(value, list):
        raise ValueError("JSON boundary arrays must be lists")
    return value


def _require_json_number(value: object) -> object:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("JSON boundary numbers must be numbers, not booleans")
    return value


def _require_iso_utc_timestamp(value: object) -> object:
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]00:00)", value,
    ):
        raise ValueError("timestamp must be an ISO-8601 UTC string")
    return value


def _require_json_string(value: object, *, maximum: int | None = None) -> None:
    if not isinstance(value, str) or (maximum is not None and len(value) > maximum):
        raise ValueError("JSON boundary strings must be bounded strings")


def _require_json_identifier(value: object) -> None:
    _require_json_string(value, maximum=100)
    if not value:
        raise ValueError("JSON boundary identifiers cannot be blank")


def _boundary_mapping(value: object, name: str) -> dict[str, Any]:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", exclude_none=True)
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be a JSON object or typed contract model")
    return value


def _required_json_field(value: dict[str, Any], field: str) -> object:
    if field not in value:
        raise ValueError(f"JSON boundary requires {field}")
    return value[field]


def _require_json_array_items(value: object, item_validator: Callable[[object], None]) -> None:
    _require_json_list(value)
    for item in value:
        item_validator(item)


def _validate_copywriter_moment(value: object) -> None:
    moment = _boundary_mapping(value, "referenced moment")
    _require_json_identifier(_required_json_field(moment, "id"))
    for field in ("title", "hook", "quote"):
        _require_json_string(_required_json_field(moment, field))
    for field in ("startSec", "endSec"):
        _require_json_number(_required_json_field(moment, field))
    if "visualHook" in moment:
        _require_json_string(moment["visualHook"], maximum=500)
    if "cropSuitability" in moment:
        _require_json_string(moment["cropSuitability"])
    if "captionSafeRegion" in moment:
        _require_json_string(moment["captionSafeRegion"], maximum=200)
    if "visualEvidenceIds" in moment:
        _require_json_array_items(moment["visualEvidenceIds"], _require_json_identifier)


def _validate_copywriter_angle(value: object) -> None:
    angle = _boundary_mapping(value, "referenced angle")
    _require_json_identifier(_required_json_field(angle, "id"))
    for field in ("kind", "title", "rationale"):
        _require_json_string(_required_json_field(angle, field))


def _validate_copywriter_brief(value: object) -> None:
    brief = _boundary_mapping(value, "content brief")
    for field in ("id", "audienceId"):
        _require_json_identifier(_required_json_field(brief, field))
    for field in ("title", "objective", "funnelStage", "keyMessage", "ctaIntent", "intendedConversion", "kpi"):
        _require_json_string(_required_json_field(brief, field))
    _require_json_number(_required_json_field(brief, "priority"))
    if isinstance(brief["priority"], bool) or not isinstance(brief["priority"], int):
        raise ValueError("brief priority must be a JSON integer")
    for field, item_validator in (
        ("channelCandidates", _require_json_identifier),
        ("formatCandidates", _require_json_identifier),
        ("dependencies", lambda item: _require_json_string(item, maximum=300)),
        ("constraints", lambda item: _require_json_string(item, maximum=300)),
        ("evidenceRefs", _require_json_identifier),
    ):
        _require_json_array_items(_required_json_field(brief, field), item_validator)


def _validate_copywriter_item(value: object) -> None:
    item = _boundary_mapping(value, "editorial item")
    for field in ("id", "briefId", "audienceId", "channel", "format"):
        _require_json_identifier(_required_json_field(item, field))
    for field in ("campaignTheme", "contentPillar", "objective", "funnelStage", "intendedConversion", "ctaIntent", "kpi", "productionStatus", "planningRationale", "selectionRationale", "confidence"):
        _require_json_string(_required_json_field(item, field))
    for field in ("priority",):
        _require_json_number(_required_json_field(item, field))
        if isinstance(item[field], bool) or not isinstance(item[field], int):
            raise ValueError("editorial item priority must be a JSON integer")
    _require_json_number(_required_json_field(item, "selectionScore"))
    for field in ("publicationWindowStartAt", "publicationWindowEndAt", "productionDeadlineAt"):
        _require_iso_utc_timestamp(_required_json_field(item, field))
    for field, item_validator in (
        ("evidenceRefs", _require_json_identifier),
        ("dependencies", _require_json_identifier),
        ("constraints", lambda entry: _require_json_string(entry, maximum=300)),
        ("requiredAssets", lambda entry: _require_json_string(entry, maximum=300)),
    ):
        if field in item:
            _require_json_array_items(item[field], item_validator)


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


class ContentClaim(StrictModel):
    text: StrictStr = Field(min_length=1, max_length=600)
    evidenceRefs: list[StrictIdentifier] = Field(min_length=1, max_length=12)

    _require_evidence_refs_list = field_validator("evidenceRefs", mode="before")(_require_json_list)


class ContentDraft(StrictModel):
    id: StrictIdentifier
    planId: StrictIdentifier
    planDigest: StrictDigest
    strategyDigest: StrictDigest
    editorialItemId: StrictIdentifier
    briefId: StrictIdentifier
    revision: StrictInt = Field(ge=1, le=2)
    platform: Literal["x"]
    format: Literal["text_post"]
    text: StrictStr = Field(min_length=1, max_length=280)
    ctaTreatment: StrictStr = Field(min_length=1, max_length=300)
    intendedConversion: StrictStr = Field(min_length=1, max_length=300)
    evidenceRefs: list[StrictIdentifier] = Field(min_length=1, max_length=12)
    claims: list[ContentClaim] = Field(..., max_length=12)
    assumptions: list[StrictAssumptionText] = Field(..., max_length=8)
    confidence: Literal["low", "medium", "high"]
    appliedConstraints: list[StrictConstraintText] = Field(min_length=1, max_length=24)
    priorDraftId: StrictIdentifier | None = Field(...)
    addressedIssueIds: list[StrictIdentifier] = Field(..., max_length=12)

    _require_lists = field_validator(
        "evidenceRefs", "claims", "assumptions", "appliedConstraints", "addressedIssueIds", mode="before",
    )(_require_json_list)

    @model_validator(mode="after")
    def validate_revision_linkage(self) -> "ContentDraft":
        if self.revision == 1:
            if self.priorDraftId is not None or self.addressedIssueIds:
                raise ValueError("original draft cannot contain revision linkage")
        elif self.priorDraftId is None or not self.addressedIssueIds:
            raise ValueError("revision draft requires prior draft linkage and addressed issue ids")
        elif self.id == self.priorDraftId:
            raise ValueError("revision draft id must be distinct from its prior draft and cannot self-link")
        if len(self.evidenceRefs) != len(set(self.evidenceRefs)):
            raise ValueError("draft evidence references must be unique")
        if len(self.addressedIssueIds) != len(set(self.addressedIssueIds)):
            raise ValueError("addressed issue ids must be unique")
        return self


class EditorialReviewIssue(StrictModel):
    id: StrictIdentifier
    category: Literal["grounding", "brief_alignment", "brand_voice", "platform_constraints", "cta", "safety", "clarity"]
    severity: Literal["low", "medium", "high"]
    fieldPath: StrictStr = Field(min_length=1, max_length=300)
    instruction: StrictStr = Field(min_length=1, max_length=1_000)
    evidenceRefs: list[StrictIdentifier] = Field(..., max_length=12)
    constraintRefs: list[StrictConstraintText] = Field(..., max_length=24)

    _require_reference_lists = field_validator("evidenceRefs", "constraintRefs", mode="before")(_require_json_list)


class EditorialReview(StrictModel):
    id: StrictIdentifier
    planId: StrictIdentifier
    planDigest: StrictDigest
    strategyDigest: StrictDigest
    editorialItemId: StrictIdentifier
    briefId: StrictIdentifier
    draftId: StrictIdentifier
    revision: StrictInt = Field(ge=1, le=2)
    verdict: Literal["accepted", "revise"]
    reviewedAt: datetime
    issues: list[EditorialReviewIssue] = Field(..., max_length=12)

    @field_validator("reviewedAt", mode="before")
    @classmethod
    def require_serialized_timestamp(cls, value: object) -> object:
        return _require_iso_utc_timestamp(value)

    @field_validator("reviewedAt")
    @classmethod
    def validate_utc_timestamp(cls, value: datetime) -> datetime:
        return _validate_utc_timestamp(value)

    @model_validator(mode="after")
    def validate_verdict_and_issues(self) -> "EditorialReview":
        if self.verdict == "accepted" and self.issues:
            raise ValueError("accepted review cannot contain revision issues")
        if self.verdict == "revise" and not self.issues:
            raise ValueError("revision review requires at least one issue")
        issue_ids = [issue.id for issue in self.issues]
        if len(issue_ids) != len(set(issue_ids)):
            raise ValueError("review issue ids must be unique")
        return self

    _require_issues_list = field_validator("issues", mode="before")(_require_json_list)


class CopywriterInput(StrictModel):
    planId: StrictIdentifier
    planDigest: StrictDigest
    strategyDigest: StrictDigest
    editorialItemId: StrictIdentifier
    briefId: StrictIdentifier
    editorialItem: EditorialPlanItem
    brief: ContentBrief
    referencedMoments: list[Moment] = Field(..., max_length=12)
    referencedAngles: list[Angle] = Field(..., max_length=12)
    brandContext: StrictStr = Field(min_length=1, max_length=4_000)
    constraints: list[StrictConstraintText] = Field(..., max_length=24)
    platform: Literal["x"]
    format: Literal["text_post"]
    passType: Literal["original", "revision"]
    priorDraft: ContentDraft | None = Field(...)
    priorReview: EditorialReview | None = Field(...)

    _require_lists = field_validator("referencedMoments", "referencedAngles", "constraints", mode="before")(_require_json_list)

    @model_validator(mode="before")
    @classmethod
    def validate_json_handoff_boundary(cls, value: object) -> object:
        if isinstance(value, BaseModel) or not isinstance(value, dict):
            return value
        _validate_copywriter_item(_required_json_field(value, "editorialItem"))
        _validate_copywriter_brief(_required_json_field(value, "brief"))
        _require_json_array_items(_required_json_field(value, "referencedMoments"), _validate_copywriter_moment)
        _require_json_array_items(_required_json_field(value, "referencedAngles"), _validate_copywriter_angle)
        _require_json_array_items(_required_json_field(value, "constraints"), lambda entry: _require_json_string(entry, maximum=300))
        return value

    @model_validator(mode="after")
    def validate_selected_authority_and_revision(self) -> "CopywriterInput":
        if self.brief.id != self.editorialItem.briefId:
            raise ValueError("copywriter input must contain the exact selected brief")
        if self.editorialItemId != self.editorialItem.id or self.briefId != self.brief.id:
            raise ValueError("copywriter input ids must match the exact selected item and brief")
        exact_fields = ("objective", "audienceId", "funnelStage", "intendedConversion", "ctaIntent", "kpi")
        if any(getattr(self.brief, field) != getattr(self.editorialItem, field) for field in exact_fields):
            raise ValueError("copywriter input brief does not match the selected editorial item")
        if set(self.brief.evidenceRefs) != set(self.editorialItem.evidenceRefs):
            raise ValueError("copywriter input brief evidence does not match the selected editorial item")
        supplied_ids = [item.id for item in [*self.referencedMoments, *self.referencedAngles]]
        if set(supplied_ids) != set(self.editorialItem.evidenceRefs) or len(supplied_ids) != len(set(supplied_ids)):
            raise ValueError("copywriter input evidence must exactly match selected evidence")
        if self.editorialItem.channel != self.platform or self.editorialItem.format != self.format:
            raise ValueError("copywriter platform and format must match the selected item")
        if self.platform not in self.brief.channelCandidates or self.format not in self.brief.formatCandidates:
            raise ValueError("copywriter platform and format must be supported by the selected brief")
        if self.passType == "original":
            if self.priorDraft is not None or self.priorReview is not None:
                raise ValueError("original pass cannot contain revision context")
        else:
            if self.priorDraft is None:
                raise ValueError("revision pass requires a prior draft")
            if self.priorReview is None:
                raise ValueError("revision pass requires a prior review")
            if self.priorReview.verdict != "revise":
                raise ValueError("revision pass requires a revise review")
            if self.priorDraft.revision != 1 or self.priorReview.revision != 1:
                raise ValueError("revision pass must target the original revision-1 draft and review")
            if self.priorReview.draftId != self.priorDraft.id or self.priorReview.revision != self.priorDraft.revision:
                raise ValueError("revision context must review the exact prior draft")
            lineage = (self.planId, self.planDigest, self.strategyDigest, self.editorialItemId, self.briefId)
            prior_lineage = (self.priorDraft.planId, self.priorDraft.planDigest, self.priorDraft.strategyDigest, self.priorDraft.editorialItemId, self.priorDraft.briefId)
            review_lineage = (self.priorReview.planId, self.priorReview.planDigest, self.priorReview.strategyDigest, self.priorReview.editorialItemId, self.priorReview.briefId)
            if lineage != prior_lineage or lineage != review_lineage:
                raise ValueError("revision context must preserve exact lineage")
        return self


class LiaisonInput(StrictModel):
    """Operator question routed to the skill-enabled insight liaison."""

    question: str = Field(min_length=1, max_length=2000)
