"""Least-privilege contracts and value-free error envelopes for ADK tools."""

from __future__ import annotations

from hashlib import sha256
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .web_client import WebApiError


class ToolContract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str = Field(pattern=r"^[a-z]+(?:_[a-z]+)+$", max_length=80)
    purpose: str = Field(min_length=20, max_length=300)
    input_schema: dict[str, str]
    return_schema: str = Field(min_length=10)
    error_codes: tuple[str, ...] = Field(min_length=1)
    permission: Literal["read"]
    data_scope: Literal["public", "workspace"]
    timeout_seconds: int = Field(ge=1, le=120)
    retry: Literal["none", "one_transient_retry"]
    external_effect: Literal[False]
    skill_names: tuple[str, ...] = Field(min_length=1)


def evidence(source: str, *, provenance: Literal["live", "mock"], reference: str | None = None) -> dict[str, Any]:
    material = f"{source}|{provenance}|{reference or ''}"
    evidence_id = f"ev-{sha256(material.encode()).hexdigest()[:16]}"
    return {
        "evidenceId": evidence_id,
        "source": source,
        "provenance": provenance,
        **({"reference": reference} if reference else {}),
    }


def success(data: dict[str, Any], *, evidence_items: list[dict[str, Any]]) -> dict[str, Any]:
    return {"status": "success", "data": data, "error": None, "evidence": evidence_items}


def error(code: str, message: str, *, category: str, retryable: bool) -> dict[str, Any]:
    return {
        "status": "error",
        "data": None,
        "error": {"code": code, "category": category, "message": message, "retryable": retryable},
        "evidence": [],
    }


def provider_error(exc: Exception) -> dict[str, Any]:
    status = exc.status if isinstance(exc, WebApiError) else None
    if status in (401, 403):
        return error("authorization_failed", "The workspace data source is not authorized.", category="authorization", retryable=False)
    if status is not None and status < 500 and status != 429:
        return error("provider_request_rejected", "The data source rejected this read request.", category="provider_permanent", retryable=False)
    return error("dependency_unavailable", "The required data source is temporarily unavailable.", category="dependency", retryable=True)
