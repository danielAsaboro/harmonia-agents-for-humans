from datetime import datetime, timezone

import pytest

from harmonia_agent.model_governance import (
    CandidateEvent,
    PromotionEvent,
    ReviewEvent,
    RollbackEvent,
    append_event,
    candidate_from_comparison,
    load_ledger,
)
from harmonia_agent.evaluation_report import RoleComparison, RoleEvaluationRecord
from decimal import Decimal


NOW = datetime(2026, 8, 26, tzinfo=timezone.utc)


def candidate(**updates):
    values = {
        "candidate_id": "cand-1",
        "role": "sophia_analyst",
        "current_model": "gemini-3.5-flash",
        "proposed_model": "gemini-3.5-pro",
        "eval_run_id": "eval-real-1",
        "evidence_digest": "a" * 64,
        "proposed_by": "operator-1",
        "created_at": NOW,
    }
    values.update(updates)
    return CandidateEvent(**values)


def test_promotion_requires_independent_approved_review_and_preserves_chain(tmp_path):
    ledger = tmp_path / "governance.jsonl"
    append_event(ledger, candidate())
    append_event(ledger, ReviewEvent(
        review_id="review-1", candidate_id="cand-1", decision="approved",
        reviewed_by="reviewer-2", reviewed_at=NOW, note="quality and cost evidence checked",
    ))
    append_event(ledger, PromotionEvent(
        promotion_id="promotion-1", candidate_id="cand-1", review_id="review-1",
        activated_by="operator-1", activated_at=NOW,
    ))

    state = load_ledger(ledger)
    assert state.active_models == {"sophia_analyst": "gemini-3.5-pro"}
    assert len(state.records) == 3
    assert state.records[1].previous_digest == state.records[0].digest
    assert state.records[2].previous_digest == state.records[1].digest


def test_proposer_cannot_approve_their_own_candidate(tmp_path):
    ledger = tmp_path / "governance.jsonl"
    append_event(ledger, candidate())
    with pytest.raises(ValueError, match="independent reviewer"):
        append_event(ledger, ReviewEvent(
            review_id="review-1", candidate_id="cand-1", decision="approved",
            reviewed_by="operator-1", reviewed_at=NOW, note="self approval",
        ))


def test_rejected_or_unreviewed_candidate_cannot_be_promoted(tmp_path):
    ledger = tmp_path / "governance.jsonl"
    append_event(ledger, candidate())
    with pytest.raises(ValueError, match="approved review"):
        append_event(ledger, PromotionEvent(
            promotion_id="promotion-1", candidate_id="cand-1", review_id="missing",
            activated_by="operator-1", activated_at=NOW,
        ))


def test_rollback_restores_exact_previous_model_and_requires_reason(tmp_path):
    ledger = tmp_path / "governance.jsonl"
    append_event(ledger, candidate())
    append_event(ledger, ReviewEvent(
        review_id="review-1", candidate_id="cand-1", decision="approved",
        reviewed_by="reviewer-2", reviewed_at=NOW, note="checked",
    ))
    append_event(ledger, PromotionEvent(
        promotion_id="promotion-1", candidate_id="cand-1", review_id="review-1",
        activated_by="operator-1", activated_at=NOW,
    ))
    append_event(ledger, RollbackEvent(
        rollback_id="rollback-1", promotion_id="promotion-1",
        reason="quality regression in verified canary", rolled_back_by="reviewer-2",
        rolled_back_at=NOW,
    ))

    assert load_ledger(ledger).active_models == {
        "sophia_analyst": "gemini-3.5-flash",
    }


def test_tampered_ledger_is_rejected(tmp_path):
    ledger = tmp_path / "governance.jsonl"
    append_event(ledger, candidate())
    ledger.write_text(ledger.read_text().replace("gemini-3.5-pro", "gemini-tampered"))
    with pytest.raises(ValueError, match="digest"):
        load_ledger(ledger)


def test_candidate_is_derived_from_the_selected_verified_comparison_record():
    selected = RoleEvaluationRecord(
        role="sophia_analyst", model_id="gemini-3.5-pro", eval_run_id="eval-real-1",
        evidence_digest="a" * 64, usage_evidence_digest="b" * 64,
        cases=({"case_id": "grounding", "passed": True, "latency_ms": 20},),
        usage_records=({
            "record_id": "usage-1", "model_id": "gemini-3.5-pro",
            "estimated_cost_usd": "0.01", "pricing_version": "pricing-v1",
        },),
        pricing_version="pricing-v1", policy_version="policy-v1",
        minimum_pass_rate=Decimal("0.95"),
    )
    comparison = RoleComparison(
        role="sophia_analyst", minimum_pass_rate=Decimal("0.95"),
        pricing_version="pricing-v1", policy_version="policy-v1",
        selected_model="gemini-3.5-pro", eligible=(selected,), rejected=(),
    )

    event = candidate_from_comparison(
        comparison, candidate_id="cand-1", current_model="gemini-3.5-flash",
        proposed_by="operator-1", created_at=NOW,
    )
    assert event.eval_run_id == "eval-real-1"
    assert event.evidence_digest == "a" * 64

    with pytest.raises(ValueError, match="selected model"):
        candidate_from_comparison(
            comparison.model_copy(update={"selected_model": "not-in-eligible"}),
            candidate_id="cand-2", current_model="gemini-3.5-flash",
            proposed_by="operator-1", created_at=NOW,
        )
