"""Deterministic host boundary for Noni/Dara multi-format production."""

from .agent_models import StrictModel
from .content_artifacts import ArtifactReviewBatch, ProductionBatch

NONI_ARTIFACT_INSTRUCTION = """You are Noni, Harmonia's bounded multi-format producer. Return exactly one typed artifact for every requested output-plan item, in request order. Use only supplied evidence IDs and text. Follow each payload schema exactly. Never approve, publish, choose credentials or destinations, invent evidence, or omit a requested item. On a revision pass, change only issues identified by Dara and preserve artifact IDs."""

DARA_ARTIFACT_INSTRUCTION = """You are Dara, Harmonia's bounded artifact editor. Review every supplied artifact independently and in order. Return exactly seven checks per artifact: grounding, brief, brand, format, cta, safety, and clarity. Accept only when all checks pass and no issue remains. Otherwise return precise issue-bound revision instructions. Never rewrite content, approve effects, publish, or invent evidence."""


class ProductionResult(StrictModel):
    original: ProductionBatch
    firstReview: ArtifactReviewBatch
    revision: ProductionBatch | None
    finalReview: ArtifactReviewBatch | None
    accepted: ProductionBatch


def finalize_production(*, original: ProductionBatch, first_review: ArtifactReviewBatch, revision: ProductionBatch | None, final_review: ArtifactReviewBatch | None, evidence_refs: list[str], output_plan_item_ids: list[str]) -> ProductionResult:
    original.validate_against(evidence_refs, output_plan_item_ids)
    original_ids = [item.id for item in original.artifacts]
    first_accepted = first_review.accepted_ids(original_ids)
    if len(first_accepted) == len(original_ids):
        if revision is not None or final_review is not None:
            raise ValueError("accepted original cannot contain revision work")
        return ProductionResult(original=original, firstReview=first_review, revision=None, finalReview=None, accepted=original)
    if revision is None or final_review is None:
        raise ValueError("revision is required after a revise decision")
    revision.validate_against(evidence_refs, output_plan_item_ids)
    if [item.id for item in revision.artifacts] != original_ids:
        raise ValueError("revision must preserve exact artifact identities")
    final_accepted = final_review.accepted_ids(original_ids)
    if len(final_accepted) != len(original_ids):
        raise ValueError("second revise requires operator attention; no third model pass")
    return ProductionResult(original=original, firstReview=first_review, revision=revision, finalReview=final_review, accepted=revision)
