"""Typed contracts shared by Harmonia's ADK specialists and stage handlers."""

from __future__ import annotations

from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


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


class Idea(StrictModel):
    topic: str = Field(min_length=1, max_length=300)
    angle: str = Field(default="", max_length=300)
    reason: str = Field(min_length=1, max_length=600)
    sources: list[str] = Field(default_factory=list, max_length=5)
    suggestedPost: str = Field(default="", max_length=280)


class StrategistInput(StrictModel):
    task: Literal["brief", "trend_scan", "calendar_gap", "recycle"]
    brief: str = Field(default="", max_length=20_000)
    signals: list[dict[str, Any]] = Field(default_factory=list, max_length=20)
    goals_text: str = Field(default="", max_length=4_000)
    learnings_text: str = Field(default="", max_length=4_000)
    post_text: str = Field(default="", max_length=1_000)
    likes: int = Field(default=0, ge=0)
    prior_learnings: str = Field(default="", max_length=4_000)

    @model_validator(mode="after")
    def validate_task_payload(self) -> "StrategistInput":
        if self.task == "brief" and not self.brief.strip():
            raise ValueError("brief task requires brief")
        if self.task == "trend_scan" and not self.signals:
            raise ValueError("trend_scan task requires signals")
        if self.task == "recycle" and not self.post_text.strip():
            raise ValueError("recycle task requires post_text")
        return self


class StrategistResult(StrictModel):
    analysis: AnalysisResult | None = None
    ideas: list[Idea] = Field(default_factory=list, max_length=6)
    strategy: "ContentStrategy | None" = None

    @model_validator(mode="after")
    def require_one_result(self) -> "StrategistResult":
        if self.analysis is None and not self.ideas and self.strategy is None:
            raise ValueError("strategist must return analysis, strategy, or ideas")
        return self


class ContentBrief(StrictModel):
    title: str = Field(min_length=1, max_length=300)
    objective: str = Field(min_length=1, max_length=600)
    sourceRefs: list[str] = Field(min_length=1, max_length=12)


class ContentStrategy(StrictModel):
    objective: str = Field(min_length=1, max_length=600)
    audience: str = Field(min_length=1, max_length=300)
    pillars: list[str] = Field(min_length=1, max_length=8)
    cadence: str = Field(min_length=1, max_length=200)
    kpis: list[str] = Field(min_length=1, max_length=8)
    briefs: list[ContentBrief] = Field(min_length=1, max_length=10)


class Draft(StrictModel):
    id: str = Field(min_length=1)
    platform: Literal["x"]
    momentId: str | None = None
    angleId: str | None = None
    text: str = Field(min_length=1, max_length=280)


class DraftSet(StrictModel):
    drafts: list[Draft] = Field(default_factory=list, max_length=10)


class DraftWorkflowInput(StrictModel):
    title: str = Field(min_length=1)
    analysis: AnalysisResult
    brand_context: str = Field(default="", max_length=4_000)
    strategy: ContentStrategy | None = None


class EditorialCalendarItem(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    platform: Literal["x"]
    objective: str = Field(min_length=1, max_length=300)
    sourceRef: str = Field(min_length=1, max_length=100)
    format: Literal["text_post"] = "text_post"
    priority: int = Field(default=1, ge=1, le=5)


class EditorialPlan(StrictModel):
    strategySummary: str = Field(min_length=1, max_length=1000)
    items: list[EditorialCalendarItem] = Field(min_length=1, max_length=10)


class PublishAction(StrictModel):
    type: Literal["publish_x_post"] = "publish_x_post"
    text: str = Field(min_length=1, max_length=280)


class ActionPlan(StrictModel):
    actions: list[PublishAction] = Field(default_factory=list, max_length=10)


class DraftWorkflowResult(StrictModel):
    editorial_plan: EditorialPlan
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
