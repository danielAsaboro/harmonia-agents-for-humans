"""Deterministic, evidence-backed role model comparison reporting."""

from __future__ import annotations

import argparse
import json
from decimal import Decimal
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class RoleEvaluationRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    role: str
    model_id: str
    pass_rate: Decimal = Field(ge=0, le=1)
    estimated_cost_usd: Decimal | None = Field(default=None, ge=0)
    p95_latency_ms: int = Field(ge=0)
    case_count: int = Field(gt=0)
    pricing_version: str
    policy_version: str


class RejectedCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    model_id: str
    reason: Literal["below_quality_floor", "unknown_cost"]


class RoleComparison(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    role: str
    minimum_pass_rate: Decimal
    pricing_version: str
    policy_version: str
    selected_model: str | None
    eligible: tuple[RoleEvaluationRecord, ...]
    rejected: tuple[RejectedCandidate, ...]


def compare_role_candidates(
    records: list[RoleEvaluationRecord], *, minimum_pass_rate: Decimal | str,
) -> RoleComparison:
    if not records:
        raise ValueError("at least one role evaluation record is required")
    roles = {record.role for record in records}
    policies = {record.policy_version for record in records}
    prices = {record.pricing_version for record in records}
    if len(roles) != 1:
        raise ValueError("candidate records must use one role")
    if len(policies) != 1:
        raise ValueError("candidate records must use one policy version")
    if len(prices) != 1:
        raise ValueError("candidate records must use one pricing version")

    floor = Decimal(minimum_pass_rate)
    if not 0 <= floor <= 1:
        raise ValueError("minimum pass rate must be between 0 and 1")
    eligible: list[RoleEvaluationRecord] = []
    rejected: list[RejectedCandidate] = []
    for record in records:
        if record.pass_rate < floor:
            rejected.append(RejectedCandidate(
                model_id=record.model_id, reason="below_quality_floor",
            ))
        elif record.estimated_cost_usd is None:
            rejected.append(RejectedCandidate(
                model_id=record.model_id, reason="unknown_cost",
            ))
        else:
            eligible.append(record)
    eligible.sort(key=lambda item: (
        -item.pass_rate,
        item.estimated_cost_usd,
        item.p95_latency_ms,
        item.model_id,
    ))
    return RoleComparison(
        role=next(iter(roles)),
        minimum_pass_rate=floor,
        pricing_version=next(iter(prices)),
        policy_version=next(iter(policies)),
        selected_model=eligible[0].model_id if eligible else None,
        eligible=tuple(eligible),
        rejected=tuple(rejected),
    )


def comparison_markdown(comparison: RoleComparison) -> str:
    lines = [
        f"# Model comparison: {comparison.role}",
        "",
        f"Quality floor: {comparison.minimum_pass_rate}",
        f"Selected model: {comparison.selected_model or 'none'}",
        f"Policy version: {comparison.policy_version}",
        f"Pricing version: {comparison.pricing_version}",
        "",
        "| Model | Pass rate | Cost USD | p95 ms | Decision |",
        "|---|---:|---:|---:|---|",
    ]
    rejected = {item.model_id: item.reason for item in comparison.rejected}
    for record in comparison.eligible:
        lines.append(
            f"| {record.model_id} | {record.pass_rate} | "
            f"{record.estimated_cost_usd} | {record.p95_latency_ms} | eligible |",
        )
    for item in comparison.rejected:
        lines.append(f"| {item.model_id} | — | — | — | {rejected[item.model_id]} |")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--minimum-pass-rate", default="0.95")
    parser.add_argument("--format", choices=("json", "markdown"), default="json")
    args = parser.parse_args()
    records = [RoleEvaluationRecord.model_validate(item) for item in json.loads(
        args.input.read_text(encoding="utf-8"),
    )]
    comparison = compare_role_candidates(
        records, minimum_pass_rate=args.minimum_pass_rate,
    )
    if args.format == "markdown":
        print(comparison_markdown(comparison), end="")
    else:
        print(comparison.model_dump_json(indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
