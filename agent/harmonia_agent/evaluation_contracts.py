"""Pure, deterministic evaluation contracts for Harmonia agent behavior."""

from __future__ import annotations

import re
import json
from collections.abc import Mapping, Sequence
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from .agent_models import (
    AnalysisResult,
    ContentDraft,
    ContentStrategy,
    CopywriterInput,
    DraftWorkflowResult,
    EditorialAssessment,
    EditorialPlan,
    EditorialPlannerInput,
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
    *, production: CopywriterInput | Mapping[str, Any],
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
            if isinstance(production, CopywriterInput)
            else CopywriterInput.model_validate(production)
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


def evaluate_content_draft(
    *, copywriter_input: CopywriterInput | Mapping[str, Any],
    draft: ContentDraft | Mapping[str, Any],
) -> EvaluationCaseResult:
    try:
        supplied = copywriter_input if isinstance(copywriter_input, CopywriterInput) else CopywriterInput.model_validate(copywriter_input)
        parsed = draft if isinstance(draft, ContentDraft) else ContentDraft.model_validate(draft)
        from .agents import validate_content_draft
        validate_content_draft(supplied, parsed)
    except Exception as exc:
        message = str(exc)
        code = (
            "authority_overreach" if "authority" in message or "publishing" in message else
            "invented_reference" if "evidence" in message or "claim" in message else
            "brief_deviation" if "brief" in message or "CTA" in message or "audience" in message or "funnel" in message else
            "invalid_draft"
        )
        return _result([_failure(code, message)])
    return _result([])


def evaluate_editorial_assessment(
    *, copywriter_input: CopywriterInput | Mapping[str, Any],
    draft: ContentDraft | Mapping[str, Any],
    assessment: EditorialAssessment | Mapping[str, Any],
) -> EvaluationCaseResult:
    try:
        supplied = copywriter_input if isinstance(copywriter_input, CopywriterInput) else CopywriterInput.model_validate(copywriter_input)
        parsed_draft = draft if isinstance(draft, ContentDraft) else ContentDraft.model_validate(draft)
        parsed = assessment if isinstance(assessment, EditorialAssessment) else EditorialAssessment.model_validate(assessment)
        from .agents import validate_editorial_assessment
        validate_editorial_assessment(supplied, parsed_draft, parsed)
    except Exception as exc:
        message = str(exc)
        code = (
            "missing_rubric" if "checks" in message or "dimension" in message else
            "invented_reference" if "unknown evidence" in message or "unknown constraint" in message else
            "authority_overreach" if "authority" in message or "replacement" in message else
            "invalid_editorial_assessment"
        )
        return _result([_failure(code, message)])
    return _result([])


def evaluate_draft_workflow(
    *, workflow: DraftWorkflowResult | Mapping[str, Any],
) -> EvaluationCaseResult:
    try:
        workflow if isinstance(workflow, DraftWorkflowResult) else DraftWorkflowResult.model_validate(workflow)
    except Exception as exc:
        return _result([_failure("invalid_revision_trace", str(exc))])
    return _result([])


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


def _public_copywriter_input() -> CopywriterInput:
    return CopywriterInput.model_validate({
        "planId": "plan-1", "planDigest": "a" * 64, "strategyDigest": "b" * 64,
        "editorialItemId": "item-1", "briefId": "brief-1",
        "editorialItem": {
            "id": "item-1", "briefId": "brief-1", "campaignTheme": "Operating proof",
            "contentPillar": "proof", "objective": "Show verified operating proof",
            "audienceId": "founders", "funnelStage": "consideration",
            "intendedConversion": "qualified demo request", "ctaIntent": "request a demo",
            "kpi": "qualified demos", "channel": "x", "format": "text_post",
            "evidenceRefs": ["moment-1"], "publicationWindowStartAt": "2026-09-01T16:00:00Z",
            "publicationWindowEndAt": "2026-09-01T18:00:00Z", "productionDeadlineAt": "2026-09-01T12:00:00Z",
            "priority": 1, "selectionScore": 1, "dependencies": [], "productionStatus": "planned",
            "constraints": ["Use an evidence-led voice"], "requiredAssets": [],
            "planningRationale": "Lead with proof.", "selectionRationale": "Selected.", "confidence": "high",
        },
        "brief": {
            "id": "brief-1", "title": "Operating proof", "objective": "Show verified operating proof",
            "audienceId": "founders", "funnelStage": "consideration",
            "keyMessage": "We cut nine days to forty hours.", "channelCandidates": ["x"],
            "formatCandidates": ["text_post"], "ctaIntent": "request a demo",
            "intendedConversion": "qualified demo request", "kpi": "qualified demos", "priority": 1,
            "dependencies": [], "constraints": ["Use an evidence-led voice"], "evidenceRefs": ["moment-1"],
        },
        "referencedMoments": [{
            "id": "moment-1", "title": "Proof", "startSec": 0, "endSec": 2,
            "hook": "Cut the delay", "quote": "We cut nine days to forty hours.",
        }],
        "referencedAngles": [], "brandContext": "Direct and evidence-led.",
        "constraints": ["Use an evidence-led voice"], "platform": "x", "format": "text_post",
        "passType": "original", "priorDraft": None, "priorReview": None,
    })


def _public_content_draft() -> ContentDraft:
    return ContentDraft.model_validate({
        "id": "draft-1", "planId": "plan-1", "planDigest": "a" * 64,
        "strategyDigest": "b" * 64, "editorialItemId": "item-1", "briefId": "brief-1",
        "revision": 1, "platform": "x", "format": "text_post", "audienceId": "founders",
        "objective": "Show verified operating proof", "funnelStage": "consideration",
        "ctaIntent": "request a demo", "text": "We cut nine days to forty hours. Request a demo.",
        "ctaTreatment": "Request a demo.", "intendedConversion": "qualified demo request",
        "evidenceRefs": ["moment-1"], "claims": [{
            "text": "We cut nine days to forty hours.", "evidenceRefs": ["moment-1"],
        }], "assumptions": [], "confidence": "high",
        "appliedConstraints": ["Use an evidence-led voice"], "priorDraftId": None,
        "addressedIssueIds": [],
    })


def _public_editorial_assessment() -> EditorialAssessment:
    dimensions = (
        "grounding", "brief_alignment", "brand_voice", "platform_constraints",
        "cta", "safety", "clarity",
    )
    return EditorialAssessment.model_validate({
        "verdict": "accepted",
        "checks": [{
            "dimension": dimension, "status": "pass",
            "rationale": f"The draft passes {dimension} review.",
            "evidenceRefs": ["moment-1"] if dimension in {"grounding", "brief_alignment"} else [],
            "constraintRefs": ["Use an evidence-led voice"] if dimension in {"brand_voice", "safety"} else [],
        } for dimension in dimensions],
        "issues": [], "resolvedIssueIds": [],
    })


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
                "draft": "noni_copywriter",
                "review": "dara_editor",
            }.get(kind))
            payload = json.loads(response_text)
            if kind == "analysis":
                result = evaluate_analysis(
                    analysis=AnalysisResult.model_validate(payload),
                    transcript=spec["transcript"],
                    duration_sec=float(spec["durationSec"]),
                )
            elif kind == "draft":
                result = evaluate_content_draft(copywriter_input=_public_copywriter_input(), draft=payload)
            elif kind == "review":
                result = evaluate_editorial_assessment(
                    copywriter_input=_public_copywriter_input(), draft=_public_content_draft(), assessment=payload,
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
