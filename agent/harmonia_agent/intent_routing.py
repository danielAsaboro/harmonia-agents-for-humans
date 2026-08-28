"""Strict, skill-owned routing for natural Harmonia operator requests."""

from __future__ import annotations

import pathlib
from typing import Literal

from google.adk.skills import load_skill_from_dir
from google.adk.tools import FunctionTool, skill_toolset
from pydantic import ConfigDict, Field, StrictBool, StrictInt, StrictStr, model_validator

from .agent_models import StrictModel
from . import web_client
from .tool_contracts import evidence, provider_error, success

SKILL_DIR = pathlib.Path(__file__).parent / "skills" / "harmonia-intent-routing"

IntentName = Literal[
    "establish_strategy", "revise_strategy", "advance_plan", "manage_calendar",
    "repurpose_source", "one_off_content", "status_evidence", "effect_request",
    "conversation",
]
OutputConcept = Literal[
    "short_social_post", "social_thread", "professional_post", "article",
    "newsletter", "caption", "carousel", "social_image", "quote_card",
    "diagram", "short_video", "calendar", "content_package",
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
    title: StrictStr | None = Field(default=None, max_length=240)


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
    recentJobs: list[RecentJobSummary] = Field(max_length=8)


class IntentRoutingInput(StrictModel):
    message: StrictStr = Field(min_length=1, max_length=2000)
    workspaceContext: WorkspaceContentContext
    attachmentCount: StrictInt = Field(ge=0, le=10)


class IntentRoute(StrictModel):
    model_config = ConfigDict(extra="forbid")

    intent: IntentName
    userOutcome: StrictStr = Field(min_length=1, max_length=500)
    sourceUrls: list[StrictStr] = Field(max_length=10)
    outputConcepts: list[OutputConcept] = Field(max_length=8)
    platformRecommendations: list[SocialPlatform] = Field(max_length=5)
    connectionSuggestions: list[SocialPlatform] = Field(max_length=5)
    assumptions: list[StrictStr] = Field(max_length=8)
    needsClarification: StrictBool
    clarifyingQuestion: StrictStr | None = Field(default=None, max_length=300)
    requiresRightsAttestation: StrictBool
    effectRequested: StrictBool
    effectAuthorized: StrictBool = False
    jobId: StrictStr | None = Field(default=None, max_length=128)

    @model_validator(mode="after")
    def enforce_authority_and_question_shape(self) -> "IntentRoute":
        if self.effectAuthorized:
            raise ValueError("intent routing cannot authorize an external effect")
        if self.effectRequested != (self.intent == "effect_request"):
            raise ValueError("effectRequested must match the effect_request intent")
        if self.needsClarification != bool(self.clarifyingQuestion):
            raise ValueError("clarifyingQuestion must match needsClarification")
        if not set(self.connectionSuggestions).issubset(self.platformRecommendations):
            raise ValueError("connection suggestions must be recommended platforms")
        return self


def build_intent_routing_skillset() -> skill_toolset.SkillToolset:
    """Load the policy skill owned by Harmonia; it exposes no effect tools."""
    return skill_toolset.SkillToolset(
        skills=[load_skill_from_dir(SKILL_DIR)],
        additional_tools=[FunctionTool(get_social_platform_connections)],
    )
