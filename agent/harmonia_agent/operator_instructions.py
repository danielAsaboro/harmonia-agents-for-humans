"""Strict cross-runtime contract for operator instruction and clarification provenance."""
from __future__ import annotations

import hashlib
import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class InstructionTurnProvenance(StrictModel):
    turnId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    messageDigest: str = Field(pattern=r"^[a-f0-9]{64}$")
    resolvedField: Literal[
        "expectedOutcome", "target", "rights", "requestedOutputs",
        "sources", "strategyContext", "activeStrategy",
    ] | None = None


class OperatorInstructionContext(StrictModel):
    originalOperatorBrief: str = Field(min_length=1, max_length=20000)
    resolvedInstructions: str = Field(min_length=1, max_length=20000)
    intakeDraftId: str = Field(pattern=r"^[a-f0-9]{64}$")
    intakeRevision: int = Field(gt=0, le=9007199254740991)
    answerTurnIds: list[str] = Field(max_length=49)
    turnProvenance: list[InstructionTurnProvenance] = Field(min_length=1, max_length=50)
    contextDigest: str = Field(pattern=r"^[a-f0-9]{64}$")

    @model_validator(mode="after")
    def verify_provenance(self):
        turn_ids = [turn.turnId for turn in self.turnProvenance]
        if len(turn_ids) != len(set(turn_ids)):
            raise ValueError("instruction turn identities must be unique")
        if self.answerTurnIds != turn_ids[1:]:
            raise ValueError("answer turn identities must match clarification provenance")
        unsigned = self.model_dump(exclude={"contextDigest"}, mode="json", exclude_none=True)
        encoded = json.dumps(unsigned, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        if hashlib.sha256(encoded).hexdigest() != self.contextDigest:
            raise ValueError("instruction context digest mismatch")
        return self


def validate_operator_instruction_context(value: object) -> dict:
    return OperatorInstructionContext.model_validate(value).model_dump(mode="json", exclude_none=True)


def validate_provider_instruction_binding(sealed_request: dict) -> dict:
    context = validate_operator_instruction_context(sealed_request.get("instructionContext"))
    request = sealed_request.get("request")
    if not isinstance(request, dict) or request.get("prompt") != context["resolvedInstructions"]:
        raise ValueError("provider prompt differs from sealed operator instructions")
    return context
