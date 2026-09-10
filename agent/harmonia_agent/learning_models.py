"""Read-only learning authority supplied by the host; memory grants no evidence authority."""
from __future__ import annotations
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, model_validator

class Record(BaseModel):
    model_config = ConfigDict(extra="forbid")

class AuthorityRef(Record):
    workspaceId: StrictStr
    brandId: StrictStr
    id: StrictStr
    revision: StrictInt = Field(gt=0)

class StrategyRef(Record):
    workspaceId: StrictStr
    brandId: StrictStr
    strategyId: StrictStr
    revision: StrictInt = Field(gt=0)
    digest: StrictStr = Field(pattern=r"^[a-f0-9]{64}$")

class Baseline(Record):
    value: float
    sampleCount: StrictInt = Field(gt=0)
    evidenceIds: list[StrictStr] = Field(min_length=1)

class MeasurementWindow(Record):
    anchor: Literal["publication", "completion"]
    startOffsetSeconds: StrictInt = Field(ge=0)
    endOffsetSeconds: StrictInt = Field(ge=0)
    collectionToleranceSeconds: StrictInt = Field(ge=0, le=86400)

class MeasurementDefinition(Record):
    id: StrictStr
    revision: StrictInt = Field(gt=0)
    metricId: StrictStr
    kind: Literal["performance", "delivery_verification"]
    unit: Literal["count", "ratio", "seconds", "boolean"]
    comparator: Literal["observe", "gte", "lte", "eq"]
    target: float | None
    baseline: Baseline | None
    window: MeasurementWindow
    collectionMethod: Literal["official_x", "operator", "unsupported", "verification_receipt"]

class PinnedMeasurement(Record):
    definition: MeasurementDefinition
    digest: StrictStr = Field(pattern=r"^[a-f0-9]{64}$")

class ObservationWindow(Record):
    startAt: StrictStr
    endAt: StrictStr

class PerformanceObservation(Record):
    id: StrictStr
    collectionId: StrictStr
    workspaceId: StrictStr
    brandId: StrictStr
    itemRef: AuthorityRef
    planRef: AuthorityRef
    campaignRef: AuthorityRef | None
    strategyRef: StrategyRef
    pillar: StrictStr | None
    jobId: StrictStr
    actionId: StrictStr | None
    artifactId: StrictStr | None
    postId: StrictStr | None
    sourceIds: list[StrictStr]
    measurement: PinnedMeasurement
    kind: Literal["performance", "delivery_verification"]
    availability: Literal["available", "pending_window", "unavailable", "failed", "revoked"]
    value: float | None
    reason: StrictStr | None
    window: ObservationWindow
    observedAt: StrictStr
    provider: Literal["x", "operator", "host", "unsupported"]
    actor: StrictStr | None
    evidenceRefs: list[StrictStr]
    digest: StrictStr

    @model_validator(mode="after")
    def verify_availability(self):
        if self.availability == "available":
            if self.value is None or self.reason is not None or not self.evidenceRefs:
                raise ValueError("available observation requires durable evidence and a value")
            if self.provider == "operator" and not self.actor:
                raise ValueError("operator observation requires attribution")
        elif self.value is not None or not self.reason:
            raise ValueError("unavailable observations must never become zero")
        if self.kind != self.measurement.definition.kind:
            raise ValueError("observation kind must match measurement definition")
        return self

class Evaluation(Record):
    id: StrictStr
    observationIds: list[StrictStr]
    measurement: PinnedMeasurement
    strategyRef: StrategyRef
    campaignRefs: list[AuthorityRef]
    planRefs: list[AuthorityRef]
    itemRefs: list[AuthorityRef]
    pillars: list[StrictStr]
    sampleCount: StrictInt = Field(ge=0)
    cohortCount: StrictInt = Field(ge=0)
    missingCounts: dict[Literal["pending_window", "unavailable", "failed", "revoked"], StrictInt]
    value: float | None
    baseline: Baseline | None
    supportingObservationIds: list[StrictStr]
    contradictingObservationIds: list[StrictStr]
    confidence: Literal["insufficient", "low", "moderate"]
    causalClaim: Literal[False]
    outcome: Literal["delivery_only", "unmeasured", "observational"]
    limitations: list[StrictStr]

    @model_validator(mode="after")
    def no_single_post_inference(self):
        if self.sampleCount < 2 and self.confidence == "moderate":
            raise ValueError("single observation is insufficient for a repeatable pattern")
        if self.sampleCount == 0 and self.value is not None:
            raise ValueError("no sample is not zero")
        return self

class EvidenceRef(Record):
    id: StrictStr
    digest: StrictStr

class TextChange(Record):
    type: Literal["cadence_guidance", "assumption"]
    value: StrictStr

class CtaChange(Record):
    type: Literal["cta_guidance"]
    value: list[StrictStr]

class PillarChange(Record):
    type: Literal["pillar_purpose"]
    pillar: StrictStr
    value: StrictStr

class StrategyChangeProposal(Record):
    requestId: StrictStr
    baseStrategyRef: StrategyRef
    changes: list[TextChange | CtaChange | PillarChange]
    rationale: StrictStr
    evidenceRefs: list[EvidenceRef]
    contradictionRefs: list[EvidenceRef]
    id: StrictStr
    workspaceId: StrictStr
    brandId: StrictStr
    revision: StrictInt
    digest: StrictStr
    actor: StrictStr
    createdAt: StrictStr
    status: Literal["pending", "approved", "rejected", "superseded"]
    evidenceStatus: Literal["valid", "revoked"]
    confidence: Literal["insufficient", "low", "moderate"]
    limitations: list[StrictStr]
    strategyProposalId: StrictStr
    proposedStrategyDigest: StrictStr
    impactedCampaignRefs: list[AuthorityRef]
    impactedPlanRefs: list[AuthorityRef]
    impactedItemRefs: list[AuthorityRef]
    decisionActor: StrictStr | None = None
    decidedAt: StrictStr | None = None
    feedback: StrictStr | None = None
    approvedStrategyRef: StrategyRef | None = None

class RevokedProposal(Record):
    id: StrictStr
    revision: StrictInt
    status: Literal["pending", "approved", "rejected", "superseded"]
    evidenceStatus: Literal["revoked"]

class LearningContext(Record):
    authority: Literal["host_persisted"] = "host_persisted"
    memoryAuthority: Literal["derived_recall_only"] = "derived_recall_only"
    observations: list[PerformanceObservation] = Field(default_factory=list, max_length=100)
    evaluations: list[Evaluation] = Field(default_factory=list, max_length=50)
    proposals: list[StrategyChangeProposal | RevokedProposal] = Field(default_factory=list, max_length=50)
    evidenceRefs: list[EvidenceRef] = Field(default_factory=list, max_length=200)

    @model_validator(mode="after")
    def redact_revoked(self):
        self.proposals = [RevokedProposal(id=p.id, revision=p.revision, status=p.status, evidenceStatus="revoked") if p.evidenceStatus == "revoked" else p for p in self.proposals]
        self.observations = [o for o in self.observations if o.availability != "revoked"]
        return self

def learning_evidence_refs(context: LearningContext) -> list[dict[str, str]]:
    eligible = {o.id for o in context.observations if o.availability == "available" and o.kind == "performance"}
    eligible.update(e.id for e in context.evaluations if e.outcome == "observational" and e.sampleCount > 0)
    eligible.update(p.id for p in context.proposals if p.evidenceStatus == "valid")
    if any(ref.id not in eligible for ref in context.evidenceRefs):
        raise ValueError("unknown or revoked learning evidence reference")
    return [ref.model_dump(mode="json") for ref in context.evidenceRefs]
