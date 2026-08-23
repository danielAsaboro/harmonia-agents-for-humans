"""Quality, cost, and latency candidate selection."""

from decimal import Decimal

from harmonia_agent.evaluation_report import RoleEvaluationRecord, compare_role_candidates


def record(
    model: str, *, pass_rate: str, cost: str | None, latency_ms: int,
) -> RoleEvaluationRecord:
    return RoleEvaluationRecord(
        role="sophia_analyst",
        model_id=model,
        pass_rate=pass_rate,
        estimated_cost_usd=cost,
        p95_latency_ms=latency_ms,
        case_count=10,
        pricing_version="pricing-test",
        policy_version="policy-test",
    )


def test_candidate_must_meet_quality_floor_before_cost_selection():
    comparison = compare_role_candidates([
        record("gemini-3.5-flash", pass_rate="1.0", cost="0.020000", latency_ms=900),
        record("gemini-3.5-flash-lite", pass_rate="0.7", cost="0.005000", latency_ms=400),
    ], minimum_pass_rate="0.95")

    assert comparison.selected_model == "gemini-3.5-flash"
    assert comparison.rejected[0].reason == "below_quality_floor"


def test_unknown_cost_cannot_be_selected():
    comparison = compare_role_candidates([
        record("unknown", pass_rate="1.0", cost=None, latency_ms=100),
    ], minimum_pass_rate="0.95")

    assert comparison.selected_model is None
    assert comparison.rejected[0].reason == "unknown_cost"


def test_quality_then_cost_then_latency_are_stable_tiebreakers():
    comparison = compare_role_candidates([
        record("slower", pass_rate="0.98", cost="0.010000", latency_ms=800),
        record("faster", pass_rate="0.98", cost="0.010000", latency_ms=500),
        record("better", pass_rate="1.0", cost="0.030000", latency_ms=900),
    ], minimum_pass_rate=Decimal("0.95"))

    assert comparison.selected_model == "better"
    assert [candidate.model_id for candidate in comparison.eligible] == [
        "better", "faster", "slower",
    ]


def test_comparison_rejects_mixed_roles_or_versions():
    records = [
        record("one", pass_rate="1", cost="0.01", latency_ms=100),
        record("two", pass_rate="1", cost="0.01", latency_ms=100).model_copy(
            update={"policy_version": "different"},
        ),
    ]

    try:
        compare_role_candidates(records, minimum_pass_rate="0.95")
    except ValueError as exc:
        assert "policy version" in str(exc)
    else:
        raise AssertionError("mixed policy versions must be rejected")
