"""Strict, versioned model assignments for every Harmonia cognitive role."""

from __future__ import annotations

import os
from decimal import Decimal, InvalidOperation
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

POLICY_VERSION = "gear-2026-08-24"


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
    provider: Literal["gemini", "vertex_endpoint"]
    model_id: str
    max_output_tokens: int
    generation: RoleGenerationPolicy = Field(
        default_factory=lambda: RoleGenerationPolicy(temperature=0.2, top_p=0.9),
    )
    policy_version: str = POLICY_VERSION
    reservation_usd: str | None = None
    endpoint: str | None = None

    @model_validator(mode="after")
    def validate_provider_configuration(self) -> "RoleModelConfig":
        if self.provider == "vertex_endpoint" and not self.endpoint:
            raise ValueError(f"{self.role} vertex endpoint is required")
        if self.provider == "gemini" and self.endpoint is not None:
            raise ValueError(f"{self.role} Gemini role cannot configure an endpoint")
        if self.reservation_usd is not None:
            try:
                value = Decimal(self.reservation_usd)
            except InvalidOperation as exc:
                raise ValueError(f"{self.role} reservation must be a decimal") from exc
            if value <= 0:
                raise ValueError(f"{self.role} reservation must be positive")
            object.__setattr__(self, "reservation_usd", f"{value:.6f}")
        return self


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


def _gemini(
    role: str,
    env_name: str,
    default: str,
    max_output_tokens: int,
    temperature: float,
) -> RoleModelConfig:
    return RoleModelConfig(
        role=role,
        provider="gemini",
        model_id=os.environ.get(env_name, default),
        max_output_tokens=max_output_tokens,
        generation=_policy(temperature),
    )


def load_role_model_catalog() -> RoleModelCatalog:
    return RoleModelCatalog(
        coordinator=_gemini(
            "harmonia_coordinator", "COORDINATOR_MODEL_ID", "gemini-3.5-flash-lite", 1024, 0.1,
        ),
        strategist=_gemini(
            "ryan_strategist", "STRATEGIST_MODEL_ID", "gemini-3.5-flash", 2048, 0.4,
        ),
        analyst=_gemini(
            "sophia_analyst", "ANALYST_MODEL_ID", "gemini-3.5-flash", 2048, 0.2,
        ),
        copywriter=RoleModelConfig(
            role="nimi_copywriter",
            provider="vertex_endpoint",
            model_id=os.environ.get("COPYWRITER_MODEL_ID", "gemma-3-12b-it"),
            max_output_tokens=2048,
            generation=_policy(0.8),
            reservation_usd=os.environ.get("GEMMA_MAX_COST_USD", "0.100000"),
            endpoint=os.environ.get("GEMMA_VERTEX_ENDPOINT") or None,
        ),
        editor=_gemini(
            "dara_editor", "EDITOR_MODEL_ID", "gemini-3.5-flash", 2048, 0.2,
        ),
        planner=_gemini(
            "temi_planner", "PLANNER_MODEL_ID", "gemini-3.5-flash-lite", 1024, 0.1,
        ),
        presenter=_gemini(
            "maya_presenter", "PRESENTER_MODEL_ID", "gemini-3.5-flash", 2048, 0.2,
        ),
        liaison=_gemini(
            "nova_liaison", "LIAISON_MODEL_ID", "gemini-3.5-flash", 2048, 0.2,
        ),
    )
