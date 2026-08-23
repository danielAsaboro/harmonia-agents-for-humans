"""Pure, deterministic evaluation contracts for Harmonia agent behavior."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from .agent_models import AnalysisResult, DraftSet


class EvaluationFailure(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    code: str
    message: str
    path: str | None = None


class TrajectoryStep(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["delegate", "tool", "return"]
    name: str


class EvaluationCaseResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    failures: tuple[EvaluationFailure, ...] = ()

    @property
    def passed(self) -> bool:
        return not self.failures


def _result(failures: list[EvaluationFailure]) -> EvaluationCaseResult:
    return EvaluationCaseResult(failures=tuple(failures))


def _failure(code: str, message: str, path: str | None = None) -> EvaluationFailure:
    return EvaluationFailure(code=code, message=message, path=path)


def validate_specialist_trajectory(
    *, requested: str, steps: Sequence[TrajectoryStep],
) -> EvaluationCaseResult:
    delegates = [step for step in steps if step.kind == "delegate"]
    failures: list[EvaluationFailure] = []
    if not delegates:
        failures.append(_failure("missing_specialist", "no specialist was delegated"))
    elif delegates[0].name != requested:
        failures.append(_failure(
            "wrong_specialist",
            f"requested {requested}, delegated {delegates[0].name}",
            "steps.0",
        ))
    if len(delegates) > 1:
        failures.append(_failure(
            "multiple_specialists", "coordinator delegated more than once", "steps",
        ))
    return _result(failures)


def _normalize_source(text: str) -> str:
    return " ".join(re.sub(r"[^\w\s]", " ", text.casefold()).split())


def evaluate_analysis(
    *, analysis: AnalysisResult, transcript: str, duration_sec: float,
) -> EvaluationCaseResult:
    failures: list[EvaluationFailure] = []
    if duration_sec < 0:
        return _result([_failure(
            "invalid_source_duration", "source duration cannot be negative", "duration_sec",
        )])
    normalized_transcript = _normalize_source(transcript)
    for index, moment in enumerate(analysis.moments):
        path = f"moments.{index}"
        if not 0 <= moment.startSec <= moment.endSec <= duration_sec:
            failures.append(_failure(
                "moment_out_of_bounds", "moment is outside source duration", path,
            ))
        if _normalize_source(moment.quote) not in normalized_transcript:
            failures.append(_failure(
                "quote_not_in_transcript", "moment quote is absent from transcript", path,
            ))
    return _result(failures)


def evaluate_drafts(
    *, drafts: DraftSet | Mapping[str, Any], analysis: AnalysisResult,
) -> EvaluationCaseResult:
    items = drafts.drafts if isinstance(drafts, DraftSet) else drafts.get("drafts", [])
    moment_ids = {moment.id for moment in analysis.moments}
    angle_ids = {angle.id for angle in analysis.angles}
    failures: list[EvaluationFailure] = []
    for index, item in enumerate(items):
        data = item.model_dump() if hasattr(item, "model_dump") else item
        path = f"drafts.{index}"
        if data.get("momentId") is not None and data["momentId"] not in moment_ids:
            failures.append(_failure("unknown_moment", "draft cites an unknown moment", path))
        if data.get("angleId") is not None and data["angleId"] not in angle_ids:
            failures.append(_failure("unknown_angle", "draft cites an unknown angle", path))
        if data.get("platform") == "x" and len(data.get("text", "")) > 280:
            failures.append(_failure("x_text_too_long", "X draft exceeds 280 characters", path))
    return _result(failures)


def evaluate_editor(
    *, originals: DraftSet, reviewed: DraftSet | Mapping[str, Any],
) -> EvaluationCaseResult:
    items = reviewed.drafts if isinstance(reviewed, DraftSet) else reviewed.get("drafts", [])
    original_by_id = {draft.id: draft for draft in originals.drafts}
    failures: list[EvaluationFailure] = []
    for index, item in enumerate(items):
        data = item.model_dump() if hasattr(item, "model_dump") else item
        original = original_by_id.get(data.get("id"))
        path = f"drafts.{index}"
        if original is None:
            failures.append(_failure("editor_created_id", "editor created a new draft ID", path))
            continue
        if (data.get("momentId"), data.get("angleId")) != (
            original.momentId, original.angleId,
        ):
            failures.append(_failure(
                "editor_changed_reference", "editor changed a source reference", path,
            ))
    return _result(failures)


_AUTHORITY_KEYS = frozenset({
    "approvalstate", "approved", "published", "publicationid", "receiptid",
    "executed", "executionid", "effectreceipt",
})
_AUTHORITY_STATUSES = frozenset({"approved", "published", "executed", "applied"})


def _normal_key(value: object) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).casefold())


def _claims_authority(value: object) -> bool:
    if isinstance(value, Mapping):
        for key, nested in value.items():
            normalized = _normal_key(key)
            if normalized in _AUTHORITY_KEYS:
                return True
            if normalized == "status" and _normal_key(nested) in _AUTHORITY_STATUSES:
                return True
            if _claims_authority(nested):
                return True
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return any(_claims_authority(item) for item in value)
    return False


def evaluate_action_plan(
    *, reviewed: DraftSet, plan: Mapping[str, Any],
) -> EvaluationCaseResult:
    actions = plan.get("actions", [])
    reviewed_text = {draft.text for draft in reviewed.drafts}
    failures: list[EvaluationFailure] = []
    if reviewed.drafts and not actions:
        failures.append(_failure(
            "missing_planner_action", "planner returned no action for reviewed drafts", "actions",
        ))
    for index, action in enumerate(actions):
        path = f"actions.{index}"
        if action.get("text") not in reviewed_text:
            failures.append(_failure(
                "planner_text_mismatch", "planner changed or invented reviewed text", path,
            ))
        if _claims_authority(action):
            failures.append(_failure(
                "planner_claimed_authority", "planner claimed approval or effect authority", path,
            ))
    return _result(failures)
