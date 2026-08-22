"""Strict, versioned model assignments for every Harmonia cognitive role."""

from __future__ import annotations

import os
from decimal import Decimal, InvalidOperation
from typing import Literal

from pydantic import BaseModel, ConfigDict, model_validator


class RoleModelConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    role: str
    provider: Literal["gemini", "vertex_endpoint"]
    model_id: str
    max_output_tokens: int
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

    def roles(self) -> tuple[RoleModelConfig, ...]:
        return (
            self.coordinator,
            self.strategist,
            self.analyst,
            self.copywriter,
            self.editor,
            self.planner,
        )

    def model_for(self, role: str) -> RoleModelConfig:
        for item in self.roles():
            if item.role == role:
                return item
        raise KeyError(f"unknown agent role: {role}")


def _gemini(role: str, env_name: str, default: str, max_output_tokens: int) -> RoleModelConfig:
    return RoleModelConfig(
        role=role,
        provider="gemini",
        model_id=os.environ.get(env_name, default),
        max_output_tokens=max_output_tokens,
    )


def load_role_model_catalog() -> RoleModelCatalog:
    return RoleModelCatalog(
        coordinator=_gemini(
            "harmonia_coordinator", "COORDINATOR_MODEL_ID", "gemini-3.5-flash-lite", 1024,
        ),
        strategist=_gemini(
            "ryan_strategist", "STRATEGIST_MODEL_ID", "gemini-3.5-flash", 2048,
        ),
        analyst=_gemini(
            "sophia_analyst", "ANALYST_MODEL_ID", "gemini-3.5-flash", 2048,
        ),
        copywriter=RoleModelConfig(
            role="nimi_copywriter",
            provider="vertex_endpoint",
            model_id=os.environ.get("COPYWRITER_MODEL_ID", "gemma-3-12b-it"),
            max_output_tokens=2048,
            reservation_usd=os.environ.get("GEMMA_MAX_COST_USD", "0.100000"),
            endpoint=os.environ.get("GEMMA_VERTEX_ENDPOINT") or None,
        ),
        editor=_gemini(
            "dara_editor", "EDITOR_MODEL_ID", "gemini-3.5-flash", 2048,
        ),
        planner=_gemini(
            "temi_planner", "PLANNER_MODEL_ID", "gemini-3.5-flash-lite", 1024,
        ),
    )
