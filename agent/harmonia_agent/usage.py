"""Provider-neutral model usage records and deterministic estimates."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict

from .model_catalog import PRICING_VERSION, estimate_text_cost


class UsageRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    job_id: str
    operation_id: str
    stage: str
    role: str
    model: str
    input_units: int
    output_units: int
    unit_type: Literal[
        "tokens", "images", "video_seconds", "audio_seconds", "endpoint_seconds"
    ] = "tokens"
    estimated_cost_usd: str
    observed_cost_usd: str | None = None
    pricing_version: str = PRICING_VERSION
    trace_id: str
    created_at: str


def estimate_request_tokens(serialized_payload: str, max_output_tokens: int) -> tuple[int, int]:
    """Return a conservative, deterministic text estimate without another model call."""
    if max_output_tokens < 0:
        raise ValueError("max_output_tokens must be non-negative")
    return ((len(serialized_payload) + 3) // 4, max_output_tokens)


class UsageAccumulator:
    def __init__(
        self,
        *,
        job_id: str,
        operation_id: str,
        stage: str,
        role: str,
        model: str,
    ) -> None:
        self.job_id = job_id
        self.operation_id = operation_id
        self.stage = stage
        self.role = role
        self.model = model
        self.input_tokens = 0
        self.output_tokens = 0

    def observe_event(self, event: object) -> None:
        metadata = getattr(event, "usage_metadata", None)
        if metadata is None:
            return
        self.input_tokens += int(getattr(metadata, "prompt_token_count", 0) or 0)
        self.output_tokens += int(getattr(metadata, "candidates_token_count", 0) or 0)

    def finalize(self, *, trace_id: str) -> UsageRecord:
        return UsageRecord(
            id=str(uuid4()),
            job_id=self.job_id,
            operation_id=self.operation_id,
            stage=self.stage,
            role=self.role,
            model=self.model,
            input_units=self.input_tokens,
            output_units=self.output_tokens,
            estimated_cost_usd=str(
                estimate_text_cost(self.model, self.input_tokens, self.output_tokens)
            ),
            trace_id=trace_id,
            created_at=datetime.now(timezone.utc).isoformat(),
        )
