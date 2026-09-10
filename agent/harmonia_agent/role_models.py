"""Strict, versioned model assignments for every Harmonia cognitive role."""

from __future__ import annotations

import os
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .model_catalog import PRICING_VERSION

POLICY_VERSION = "strands-2026-09-09"


class RoleGenerationPolicy(BaseModel):
    """Provider-neutral sampling and safety settings for one cognitive role."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    temperature: float
    top_p: float | None = None
    top_k: int | None = None
    safety_profile: Literal["harmonia-standard"] = "harmonia-standard"

    @model_validator(mode="after")
    def validate_bounds(self) -> "RoleGenerationPolicy":
        if not 0 <= self.temperature <= 2:
            raise ValueError("temperature must be between 0 and 2")
        if self.top_p is not None and not 0 < self.top_p <= 1:
            raise ValueError("top_p must be greater than 0 and at most 1")
        if self.top_k is not None and self.top_k < 1:
            raise ValueError("top_k must be positive")
        return self


class RoleModelConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    role: str
    provider: Literal["bedrock"]
    model_id: str
    max_output_tokens: int
    generation: RoleGenerationPolicy = Field(
        default_factory=lambda: RoleGenerationPolicy(temperature=0.2, top_p=0.9),
    )
    policy_version: str = POLICY_VERSION
    pricing_version: str = PRICING_VERSION
    timeout_seconds: int = Field(default=120, gt=0, le=600)
    eligible_tasks: tuple[str, ...] = ("*",)
    minimum_pass_rate: Decimal = Field(default=Decimal("0.95"), ge=0, le=1)
    reservation_usd: str | None = None
    endpoint: str | None = None

    @model_validator(mode="after")
    def validate_provider_configuration(self) -> "RoleModelConfig":
        if self.endpoint is not None:
            raise ValueError("Bedrock roles use model IDs, not endpoint overrides")
        if self.reservation_usd is not None:
            try:
                value = Decimal(self.reservation_usd)
            except InvalidOperation as exc:
                raise ValueError(f"{self.role} reservation must be a decimal") from exc
            if value <= 0:
                raise ValueError(f"{self.role} reservation must be positive")
            object.__setattr__(self, "reservation_usd", f"{value:.6f}")
        return self

    def policy_snapshot(self) -> dict[str, Any]:
        """Return the exact immutable policy fields recorded with an invocation."""
        return {
            "policyVersion": self.policy_version,
            "pricingVersion": self.pricing_version,
            "temperature": self.generation.temperature,
            "topP": None,
            "topK": None,
            "safetyProfile": self.generation.safety_profile,
            "maxOutputTokens": self.max_output_tokens,
            "timeoutSeconds": self.timeout_seconds,
            "eligibleTasks": list(self.eligible_tasks),
            "minimumPassRate": str(self.minimum_pass_rate),
        }


class RoleModelCatalog(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    coordinator: RoleModelConfig
    strategist: RoleModelConfig
    analyst: RoleModelConfig
    copywriter: RoleModelConfig
    editor: RoleModelConfig
    planner: RoleModelConfig
    presenter: RoleModelConfig
    liaison: RoleModelConfig

    def roles(self) -> tuple[RoleModelConfig, ...]:
        return (
            self.coordinator,
            self.strategist,
            self.analyst,
            self.copywriter,
            self.editor,
            self.planner,
            self.presenter,
            self.liaison,
        )

    def model_for(self, role: str) -> RoleModelConfig:
        for item in self.roles():
            if item.role == role:
                return item
        raise KeyError(f"unknown agent role: {role}")


def _policy(temperature: float) -> RoleGenerationPolicy:
    return RoleGenerationPolicy(temperature=temperature, top_p=0.9)


def _bedrock(
    role: str,
    env_name: str,
    default: str,
    max_output_tokens: int,
    temperature: float,
    eligible_tasks: tuple[str, ...],
    timeout_seconds: int = 120,
) -> RoleModelConfig:
    timeout_env = env_name.removesuffix("MODEL_ID") + "TIMEOUT_SECONDS"
    return RoleModelConfig(
        role=role,
        provider="bedrock",
        model_id=os.environ.get(env_name, default),
        max_output_tokens=max_output_tokens,
        timeout_seconds=int(os.environ.get(timeout_env, str(timeout_seconds))),
        generation=_policy(temperature),
        eligible_tasks=eligible_tasks,
    )


def load_role_model_catalog() -> RoleModelCatalog:
    return RoleModelCatalog(
        coordinator=_bedrock(
            "harmonia_coordinator", "COORDINATOR_MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0", 1024, 0.1,
            ("route",),
        ),
        strategist=_bedrock(
            "ryan_strategist", "STRATEGIST_MODEL_ID", "us.anthropic.claude-sonnet-4-6", 8192, 0.1,
            ("strategize",), 300,
        ),
        analyst=_bedrock(
            "nimi_analyst", "ANALYST_MODEL_ID", "us.amazon.nova-2-lite-v1:0", 8192, 0.2,
            ("analyze_media", "analyze_sources"),
        ),
        copywriter=_bedrock(
            "noni_copywriter", "COPYWRITER_MODEL_ID", "us.anthropic.claude-sonnet-4-6", 2048, 0.8,
            ("draft_or_revise_x",),
        ),
        editor=_bedrock(
            "dara_editor", "EDITOR_MODEL_ID", "us.anthropic.claude-sonnet-4-6", 2048, 0.2,
            ("review_drafts",),
        ),
        planner=_bedrock(
            "temi_editorial_planner", "PLANNER_MODEL_ID", "us.anthropic.claude-sonnet-4-6", 8192, 0.1,
            ("propose_editorial_plan",),
        ),
        presenter=_bedrock(
            "maya_presenter", "PRESENTER_MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0", 2048, 0.2,
            ("compose_surface",),
        ),
        liaison=_bedrock(
            "nova_liaison", "LIAISON_MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0", 2048, 0.2,
            ("answer_status", "answer_insights"),
        ),
    )
