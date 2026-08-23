"""Strict reference-only contracts for Harmonia's generated A2UI surfaces."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


SurfaceSlot = Literal["canvas", "conversation", "approval"]
ComponentName = Literal[
    "CampaignBrief",
    "JobProgress",
    "MomentExplorer",
    "DraftComparison",
    "PlatformPreview",
    "SourceEvidence",
    "ApprovalReview",
    "VerificationReceipt",
    "SurfaceLoading",
    "SurfaceEmpty",
    "SurfaceUnresolved",
    "SurfaceFailure",
]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class JobSummary(StrictModel):
    id: str = Field(min_length=1, max_length=200)
    stage: str = Field(min_length=1, max_length=100)
    status: str = Field(min_length=1, max_length=100)
    title: str | None = Field(default=None, max_length=300)
    sourceKind: Literal["written", "video", "audio", "mixed"]


class DraftSummary(StrictModel):
    id: str = Field(min_length=1, max_length=200)
    platform: str = Field(min_length=1, max_length=50)
    valid: bool
    momentId: str | None = Field(default=None, max_length=200)
    angleId: str | None = Field(default=None, max_length=200)


class MomentSummary(StrictModel):
    id: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=300)
    startSec: float = Field(ge=0)
    endSec: float = Field(ge=0)

    @model_validator(mode="after")
    def validate_time_range(self) -> "MomentSummary":
        if self.endSec < self.startSec:
            raise ValueError("moment endSec must not precede startSec")
        return self


class SourceSummary(StrictModel):
    id: str = Field(min_length=1, max_length=200)
    kind: Literal["video", "audio", "transcript", "media", "http"]
    label: str = Field(min_length=1, max_length=300)


class AssetSummary(StrictModel):
    actionId: str = Field(min_length=1, max_length=200)
    kind: Literal["image", "video", "audio", "document", "other"]
    mime: str = Field(min_length=1, max_length=120)


class ActionSummary(StrictModel):
    id: str = Field(min_length=1, max_length=200)
    type: str = Field(min_length=1, max_length=100)
    pending: bool


class ReceiptSummary(StrictModel):
    id: str = Field(min_length=1, max_length=200)
    actionId: str = Field(min_length=1, max_length=200)
    outcome: Literal["applied", "already_applied", "rejected", "failed"]
    verified: bool


class UiContext(StrictModel):
    operatorRequest: str = Field(min_length=1, max_length=2_000)
    intent: str = Field(min_length=1, max_length=100)
    job: JobSummary | None = None
    drafts: list[DraftSummary] = Field(default_factory=list, max_length=20)
    moments: list[MomentSummary] = Field(default_factory=list, max_length=20)
    sources: list[SourceSummary] = Field(default_factory=list, max_length=50)
    assets: list[AssetSummary] = Field(default_factory=list, max_length=20)
    actions: list[ActionSummary] = Field(default_factory=list, max_length=20)
    receipts: list[ReceiptSummary] = Field(default_factory=list, max_length=20)


class EntityRefs(StrictModel):
    jobId: str | None = Field(default=None, max_length=200)
    draftIds: list[str] = Field(default_factory=list, max_length=20)
    momentIds: list[str] = Field(default_factory=list, max_length=20)
    sourceIds: list[str] = Field(default_factory=list, max_length=50)
    assetActionIds: list[str] = Field(default_factory=list, max_length=20)
    actionIds: list[str] = Field(default_factory=list, max_length=20)
    receiptIds: list[str] = Field(default_factory=list, max_length=20)


class SurfacePlanNode(StrictModel):
    id: str = Field(min_length=1, max_length=200)
    component: ComponentName
    refs: EntityRefs = Field(default_factory=EntityRefs)
    title: str | None = Field(default=None, max_length=160)
    emphasis: Literal["primary", "secondary", "compact"] = "primary"
    children: list[str] = Field(default_factory=list, max_length=30)


class PlannedSurface(StrictModel):
    slot: SurfaceSlot
    revision: int = Field(ge=1)
    rootId: str = Field(min_length=1, max_length=200)
    nodes: list[SurfacePlanNode] = Field(min_length=1, max_length=40)

    @model_validator(mode="after")
    def validate_graph(self) -> "PlannedSurface":
        ids = [node.id for node in self.nodes]
        if len(ids) != len(set(ids)):
            raise ValueError("surface graph node ids must be unique")
        if self.rootId not in ids:
            raise ValueError("surface graph must include rootId")
        if any(child not in ids for node in self.nodes for child in node.children):
            raise ValueError("surface graph contains a dangling child")
        return self


class SurfacePlan(StrictModel):
    version: Literal["harmonia.ui/v1"]
    surfaces: list[PlannedSurface] = Field(min_length=1, max_length=3)

    @model_validator(mode="after")
    def validate_slots(self) -> "SurfacePlan":
        slots = [surface.slot for surface in self.surfaces]
        if len(slots) != len(set(slots)):
            raise ValueError("surface plan slots must be unique")
        return self

