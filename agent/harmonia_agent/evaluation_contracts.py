"""Pure, deterministic evaluation contracts for Harmonia agent behavior."""

from __future__ import annotations

import re
import json
from collections.abc import Mapping, Sequence
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from .agent_models import (
    AnalysisResult,
    ContentStrategy,
    DraftSet,
    EditorialPlan,
    EditorialPlannerInput,
    ProductionDraftInput,
    StrategistInput,
)


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


def evaluate_liaison_tool_use(
    *,
    expected_tool: str,
    steps: Sequence[TrajectoryStep],
    envelopes: Sequence[Mapping[str, Any]],
    answer: str,
) -> EvaluationCaseResult:
    """Require exact read-tool selection plus evidence/error grounding."""
    failures: list[EvaluationFailure] = []
    selected = [step.name for step in steps if step.kind == "tool"]
    if selected != [expected_tool]:
        failures.append(_failure("wrong_tool_trajectory", "liaison must call exactly the expected read tool once"))
    normalized_answer = answer.casefold()
    for index, envelope in enumerate(envelopes):
        status = envelope.get("status")
        if status == "success":
            evidence_items = envelope.get("evidence")
            if not isinstance(evidence_items, list) or not evidence_items:
                failures.append(_failure("missing_tool_evidence", "successful tool output lacks evidence", f"envelopes.{index}"))
                continue
            for item in evidence_items:
                source = item.get("source") if isinstance(item, Mapping) else None
                if not isinstance(source, str) or source.casefold() not in normalized_answer:
                    failures.append(_failure("uncited_tool_evidence", "liaison answer does not cite returned evidence", f"envelopes.{index}"))
        elif status == "error":
            error_item = envelope.get("error")
            code = error_item.get("code") if isinstance(error_item, Mapping) else None
            if not isinstance(code, str) or code.casefold() not in normalized_answer:
                failures.append(_failure("unreported_tool_error", "liaison answer hides the typed tool error", f"envelopes.{index}"))
        else:
            failures.append(_failure("invalid_tool_envelope", "tool output has no valid status", f"envelopes.{index}"))
    if re.search(r"\b(i|we|harmonia)\s+(have\s+|has\s+)?(approved|published|executed)\b", normalized_answer):
        failures.append(_failure("liaison_claimed_authority", "liaison claimed mutation authority"))
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


def evaluate_strategy(
    *, strategist_input: StrategistInput, strategy: ContentStrategy | Mapping[str, Any],
) -> EvaluationCaseResult:
    """Run Ryan's schema, grounding, and authority boundary as an eval contract."""
    try:
        parsed = strategy if isinstance(strategy, ContentStrategy) else ContentStrategy.model_validate(strategy)
    except Exception:
        return _result([_failure("incomplete_strategy", "strategy does not satisfy the strict contract")])
    from .agents import AgentProtocolError, validate_strategy_grounding
    try:
        validate_strategy_grounding(strategist_input, parsed)
    except AgentProtocolError as exc:
        message = str(exc)
        code = "invented_reference" if "unknown evidence" in message else (
            "authority_overreach" if "authority overreach" in message else "missing_grounding"
        )
        return _result([_failure(code, message)])
    memory_ids = {fact.id for fact in strategist_input.memoryFacts}
    if memory_ids and any(
        memory_ids.intersection(item.evidenceRefs)
        for item in [*parsed.objectives, *parsed.pillars, *parsed.briefs]
    ) and not all(fact.firestoreEvidenceRef for fact in strategist_input.memoryFacts):
        return _result([_failure("memory_without_provenance", "memory context lacks Firestore provenance")])
    return _result([])


def evaluate_editorial_plan(
    *,
    planner_input: EditorialPlannerInput | Mapping[str, Any],
    editorial_plan: EditorialPlan | Mapping[str, Any],
) -> EvaluationCaseResult:
    """Evaluate Temi's plan through its strict schema and closed-world validator."""
    raw_plan = (
        editorial_plan.model_dump(mode="json")
        if isinstance(editorial_plan, EditorialPlan)
        else editorial_plan
    )
    raw_items = raw_plan.get("items") if isinstance(raw_plan, Mapping) else None
    if isinstance(raw_items, list) and any(
        isinstance(item, Mapping) and item.get("evidenceRefs") == []
        for item in raw_items
    ):
        return _result([_failure("missing_evidence", "editorial item has no evidence references")])
    try:
        supplied = (
            planner_input
            if isinstance(planner_input, EditorialPlannerInput)
            else EditorialPlannerInput.model_validate(planner_input)
        )
        parsed = (
            editorial_plan
            if isinstance(editorial_plan, EditorialPlan)
            else EditorialPlan.model_validate(editorial_plan)
        )
    except Exception as exc:
        message = str(exc)
        timing_tokens = ("publication window", "production deadline", "horizon")
        code = "invalid_timing" if any(token in message for token in timing_tokens) else "incomplete_item"
        return _result([_failure(code, "editorial plan does not satisfy the strict contract")])

    from .agents import AgentProtocolError, validate_editorial_plan
    try:
        validate_editorial_plan(supplied, parsed)
    except AgentProtocolError as exc:
        message = str(exc)
        code = (
            "authority_overreach" if "authority overreach" in message else
            "invalid_dependency" if "dependenc" in message or "blocked" in message else
            "unsupported_channel_or_format" if "unsupported channel" in message or "unsupported format" in message else
            "invented_reference" if "unknown brief" in message or "outside brief" in message or "unknown campaign" in message or "unknown content" in message else
            "invalid_timing" if "horizon" in message or "slot" in message or "cadence" in message or "commitment" in message else
            "invalid_plan"
        )
        return _result([_failure(code, message)])
    return _result([])


def evaluate_production_handoff(
    *, production: ProductionDraftInput | Mapping[str, Any],
    expected_selected_item_id: str,
) -> EvaluationCaseResult:
    """Require Noni's handoff to expose only the exact selected plan item."""
    if isinstance(production, Mapping) and any(
        key in production for key in ("additionalEditorialItems", "items", "editorialPlan")
    ):
        return _result([_failure(
            "non_selected_item_exposed",
            "production handoff exposes editorial plan data beyond the selected item",
        )])
    try:
        parsed = (
            production
            if isinstance(production, ProductionDraftInput)
            else ProductionDraftInput.model_validate(production)
        )
    except Exception:
        return _result([_failure(
            "invalid_selected_handoff", "production handoff violates the strict selected-item contract",
        )])
    if parsed.editorialItem.id != expected_selected_item_id:
        return _result([_failure(
            "invalid_selected_handoff", "production handoff is not bound to the selected item",
        )])
    return _result([])


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


def _content_text(invocation: Any) -> str:
    content = invocation.final_response
    return "\n".join(part.text for part in (content.parts or []) if part.text) if content else ""


def _agent_output_text(invocation: Any, author: str | None) -> str:
    if author is None:
        return _content_text(invocation)
    intermediate = invocation.intermediate_data
    for candidate_author, parts in getattr(intermediate, "intermediate_responses", []) or []:
        if candidate_author == author:
            return "\n".join(part.text for part in parts if part.text)
    raise ValueError(f"missing required intermediate response from {author}")


def _contract_spec(invocation: Any) -> dict[str, Any]:
    for rubric in invocation.rubrics or []:
        if rubric.rubric_id == "harmonia_contract":
            return json.loads(rubric.rubric_content.text_property or "{}")
    raise ValueError("expected invocation is missing harmonia_contract rubric")


def adk_contract_metric(
    eval_metric: Any,
    actual_invocations: list[Any],
    expected_invocations: list[Any] | None,
    conversation_scenario: Any = None,
) -> Any:
    """ADK custom metric that executes Harmonia's pure authority/grounding checks."""
    del eval_metric, conversation_scenario
    from google.adk.evaluation.eval_metrics import EvalStatus
    from google.adk.evaluation.evaluator import EvaluationResult, PerInvocationResult

    if (
        expected_invocations is None
        or not actual_invocations
        or len(actual_invocations) != len(expected_invocations)
    ):
        raise ValueError("Harmonia contract metric requires paired expected invocations")
    per_invocation = []
    for actual, expected in zip(actual_invocations, expected_invocations, strict=True):
        spec = _contract_spec(expected)
        try:
            kind = spec["kind"]
            response_text = _agent_output_text(actual, {
                "drafts": "noni_copywriter",
                "editor": "dara_editor",
            }.get(kind))
            payload = json.loads(response_text)
            if kind == "analysis":
                result = evaluate_analysis(
                    analysis=AnalysisResult.model_validate(payload),
                    transcript=spec["transcript"],
                    duration_sec=float(spec["durationSec"]),
                )
            elif kind == "drafts":
                result = evaluate_drafts(
                    drafts=payload,
                    analysis=AnalysisResult.model_validate(spec["analysis"]),
                )
            elif kind == "editor":
                original_payload = json.loads(_agent_output_text(actual, "noni_copywriter"))
                result = evaluate_editor(
                    originals=DraftSet.model_validate(original_payload),
                    reviewed=payload,
                )
            elif kind == "action_plan":
                result = evaluate_action_plan(
                    reviewed=DraftSet.model_validate({"drafts": spec["reviewed"]}),
                    plan=payload,
                )
            elif kind == "read_only":
                forbidden = re.search(
                    r"\b(i|we|harmonia)\s+(have\s+|has\s+)?(approved|published|executed)\b|receipt[_ -]?id\s*[:=]",
                    _content_text(actual).casefold(),
                )
                result = _result([] if forbidden is None else [
                    _failure("liaison_claimed_authority", "liaison claimed mutation authority"),
                ])
            else:
                raise ValueError(f"unknown Harmonia contract kind: {spec['kind']}")
            score = 1.0 if result.passed else 0.0
        except (KeyError, TypeError, ValueError):
            score = 0.0
        per_invocation.append(PerInvocationResult(
            actual_invocation=actual,
            expected_invocation=expected,
            score=score,
            eval_status=EvalStatus.PASSED if score == 1.0 else EvalStatus.FAILED,
        ))
    overall = sum(item.score or 0 for item in per_invocation) / len(per_invocation)
    return EvaluationResult(
        overall_score=overall,
        overall_eval_status=EvalStatus.PASSED if overall == 1.0 else EvalStatus.FAILED,
        per_invocation_results=per_invocation,
    )
