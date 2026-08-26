"""Closed-world contracts for Noni copywriting and Dara editorial review."""

from __future__ import annotations

from copy import deepcopy

import pytest
from pydantic import ValidationError

from harmonia_agent.agent_models import (
    Angle,
    ContentBrief,
    ContentDraft,
    CopywriterInput,
    EditorialPlanItem,
    EditorialReview,
    Moment,
)


def _brief() -> dict:
    return {
        "id": "brief-1", "title": "Operational proof", "objective": "Show verified operating proof",
        "audienceId": "founders", "funnelStage": "consideration", "keyMessage": "Harmonia keeps content execution governed.",
        "channelCandidates": ["x"], "formatCandidates": ["text_post"], "ctaIntent": "request a demo",
        "intendedConversion": "qualified demo request", "kpi": "qualified demos", "priority": 1,
        "dependencies": [], "constraints": ["Use an evidence-led voice"], "evidenceRefs": ["moment-1", "angle-1"],
    }


def _editorial_item() -> dict:
    return {
        "id": "item-1", "briefId": "brief-1", "campaignTheme": "Evidence before execution", "contentPillar": "operational proof",
        "objective": "Show verified operating proof", "audienceId": "founders", "funnelStage": "consideration",
        "intendedConversion": "qualified demo request", "ctaIntent": "request a demo", "kpi": "qualified demos",
        "channel": "x", "format": "text_post", "evidenceRefs": ["moment-1", "angle-1"],
        "publicationWindowStartAt": "2026-09-01T16:00:00Z", "publicationWindowEndAt": "2026-09-01T18:00:00Z",
        "productionDeadlineAt": "2026-08-31T18:00:00Z", "priority": 1, "selectionScore": 0.9,
        "dependencies": [], "productionStatus": "planned", "constraints": ["Use an evidence-led voice"], "requiredAssets": [],
        "planningRationale": "The first proof post opens the campaign.", "selectionRationale": "It is the selected item.", "confidence": "high",
    }


def _evidence() -> tuple[list[dict], list[dict]]:
    return ([{
        "id": "moment-1", "title": "Activation lesson", "startSec": 1, "endSec": 8,
        "hook": "Cut the delay", "quote": "We cut nine days to forty hours.",
    }], [{
        "id": "angle-1", "kind": "trend", "title": "Evidence-led execution",
        "rationale": "Founders need verifiable operating proof.",
    }])


def original_draft() -> dict:
    return {
        "id": "draft-1", "planId": "plan-1", "planDigest": "a" * 64, "strategyDigest": "b" * 64,
        "editorialItemId": "item-1", "briefId": "brief-1", "revision": 1, "platform": "x", "format": "text_post",
        "text": "Evidence-led teams cut the gap between a content decision and its governed execution. Request a demo.",
        "ctaTreatment": "Invite founders to request a demo.", "intendedConversion": "qualified demo request",
        "evidenceRefs": ["moment-1", "angle-1"],
        "claims": [{"text": "The source describes reducing a nine-day delay to forty hours.", "evidenceRefs": ["moment-1"]}],
        "assumptions": ["A direct founder-focused hook suits the selected X item."], "confidence": "high",
        "appliedConstraints": ["Use an evidence-led voice"], "priorDraftId": None, "addressedIssueIds": [],
    }


def revise_review() -> dict:
    return {
        "id": "review-1", "planId": "plan-1", "planDigest": "a" * 64, "strategyDigest": "b" * 64,
        "editorialItemId": "item-1", "briefId": "brief-1", "draftId": "draft-1", "revision": 1,
        "verdict": "revise", "reviewedAt": "2026-08-27T10:00:00Z",
        "issues": [{
            "id": "issue-1", "category": "clarity", "severity": "medium", "fieldPath": "text",
            "instruction": "Name the source qualification before the call to action.", "evidenceRefs": ["moment-1"], "constraintRefs": [],
        }],
    }


def original_input() -> dict:
    moments, angles = _evidence()
    return {
        "planId": "plan-1", "planDigest": "a" * 64, "strategyDigest": "b" * 64,
        "editorialItemId": "item-1", "briefId": "brief-1", "editorialItem": _editorial_item(), "brief": _brief(),
        "referencedMoments": moments, "referencedAngles": angles, "brandContext": "Direct, evidence-led, and concise.",
        "constraints": ["Use an evidence-led voice"], "platform": "x", "format": "text_post", "passType": "original",
        "priorDraft": None, "priorReview": None,
    }


def revision_input() -> dict:
    value = original_input()
    value.update({"passType": "revision", "priorDraft": original_draft(), "priorReview": revise_review()})
    return value


def revision_draft() -> dict:
    value = original_draft()
    value.update({"id": "draft-2", "revision": 2, "text": "The source describes cutting a nine-day delay to forty hours. Request a demo for governed content execution.", "priorDraftId": "draft-1", "addressedIssueIds": ["issue-1"]})
    return value


def test_complete_original_and_revision_contracts_preserve_single_item_lineage():
    original = CopywriterInput.model_validate(original_input())
    revised = CopywriterInput.model_validate(revision_input())
    draft = ContentDraft.model_validate(original_draft())
    revision = ContentDraft.model_validate(revision_draft())
    review = EditorialReview.model_validate(revise_review())

    assert (original.planId, original.editorialItem.id, original.brief.id, original.platform, original.format) == ("plan-1", "item-1", "brief-1", "x", "text_post")
    assert revised.priorDraft is not None and revised.priorDraft.id == "draft-1"
    assert revised.priorReview is not None and revised.priorReview.issues[0].id == "issue-1"
    assert draft.claims[0].evidenceRefs == ["moment-1"]
    assert revision.priorDraftId == "draft-1" and revision.addressedIssueIds == ["issue-1"]
    assert review.verdict == "revise"


@pytest.mark.parametrize(("factory", "mutation", "message"), [
    (original_input, lambda value: value.update(unexpected="no"), "extra_forbidden"),
    (original_draft, lambda value: value.update(alternatives=["Second post"]), "extra_forbidden"),
    (original_input, lambda value: value["brief"].update(id="brief-other"), "exact selected brief"),
    (original_input, lambda value: value["referencedAngles"].append({"id": "extra", "kind": "trend", "title": "Extra", "rationale": "Extra"}), "evidence"),
    (original_input, lambda value: value.update(priorDraft=original_draft()), "original"),
    (revision_input, lambda value: value.update(priorDraft=None), "prior draft"),
    (revision_input, lambda value: value.update(priorReview=None), "prior review"),
    (original_input, lambda value: value.update(platform="linkedin"), "literal_error"),
    (original_draft, lambda value: value.update(confidence="certain"), "literal_error"),
    (original_draft, lambda value: value.update(publishPayload={"type": "publish_x_post"}), "extra_forbidden"),
    (revise_review, lambda value: value.update(receipt={"id": "forbidden"}), "extra_forbidden"),
    (original_draft, lambda value: value.update(text="x" * 281), "string_too_long"),
])
def test_noni_dara_contracts_fail_closed_for_boundary_and_authority_violations(factory, mutation, message):
    payload = deepcopy(factory())
    mutation(payload)
    model = CopywriterInput if factory in {original_input, revision_input} else ContentDraft if factory is original_draft else EditorialReview
    with pytest.raises(ValidationError, match=message):
        model.model_validate(payload)


@pytest.mark.parametrize(("factory", "mutation"), [
    (original_input, lambda value: value["referencedMoments"].__setitem__(0, {**value["referencedMoments"][0], "id": ""})),
    (original_draft, lambda value: value.update(claims=[value["claims"][0]] * 13)),
    (original_draft, lambda value: value.update(evidenceRefs=[])),
    (original_draft, lambda value: value.update(appliedConstraints=[""])),
    (revise_review, lambda value: value.update(reviewedAt="2026-08-27T11:00:00+01:00")),
    (revise_review, lambda value: value.update(issues=[])),
])
def test_noni_dara_contracts_enforce_nonblank_lists_and_utc_fields(factory, mutation):
    payload = deepcopy(factory())
    mutation(payload)
    model = CopywriterInput if factory is original_input else ContentDraft if factory is original_draft else EditorialReview
    with pytest.raises(ValidationError):
        model.model_validate(payload)


@pytest.mark.parametrize(("factory", "field"), [
    (original_draft, "claims"),
    (original_draft, "assumptions"),
    (original_draft, "priorDraftId"),
    (original_draft, "addressedIssueIds"),
    (original_input, "referencedMoments"),
    (original_input, "referencedAngles"),
    (original_input, "constraints"),
    (original_input, "priorDraft"),
    (original_input, "priorReview"),
    (revise_review, "issues"),
    (revise_review, "issues.0.evidenceRefs"),
    (revise_review, "issues.0.constraintRefs"),
])
def test_new_boundary_lists_and_nullable_fields_are_required(factory, field):
    payload = deepcopy(factory())
    if field.startswith("issues.0."):
        del payload["issues"][0][field.rsplit(".", maxsplit=1)[-1]]
    else:
        del payload[field]
    model = CopywriterInput if factory is original_input else ContentDraft if factory is original_draft else EditorialReview
    with pytest.raises(ValidationError, match=field):
        model.model_validate(payload)


@pytest.mark.parametrize(("factory", "mutation"), [
    (original_draft, lambda value: value.update(revision="1")),
    (original_draft, lambda value: value["claims"][0].update(text=1)),
    (original_draft, lambda value: value.update(assumptions=[1])),
    (original_input, lambda value: value.update(planId=1)),
    (original_input, lambda value: value.update(constraints=[1])),
    (revise_review, lambda value: value.update(revision="1")),
    (revise_review, lambda value: value.update(reviewedAt=1)),
    (revise_review, lambda value: value["issues"][0].update(instruction=1)),
    (revise_review, lambda value: value["issues"][0].update(evidenceRefs=[1])),
    (revise_review, lambda value: value["issues"][0].update(constraintRefs=[1])),
])
def test_new_boundary_scalars_do_not_coerce(factory, mutation):
    payload = deepcopy(factory())
    mutation(payload)
    model = CopywriterInput if factory is original_input else ContentDraft if factory is original_draft else EditorialReview
    with pytest.raises(ValidationError):
        model.model_validate(payload)


@pytest.mark.parametrize(("factory", "mutation", "message"), [
    (revision_draft, lambda value: value.update(id="draft-1"), "distinct"),
    (revision_draft, lambda value: value.update(priorDraftId="draft-2"), "self"),
    (revision_input, lambda value: value.update(
        priorDraft=revision_draft(),
        priorReview={**revise_review(), "draftId": "draft-2", "revision": 2},
    ), "original revision-1"),
])
def test_one_revision_boundary_rejects_id_reuse_and_third_pass_targets(factory, mutation, message):
    payload = deepcopy(factory())
    mutation(payload)
    model = CopywriterInput if factory is revision_input else ContentDraft
    with pytest.raises(ValidationError, match=message):
        model.model_validate(payload)


@pytest.mark.parametrize(("factory", "mutation"), [
    (original_input, lambda value: value["referencedMoments"][0].update(startSec="1")),
    (original_input, lambda value: value["referencedMoments"][0].update(startSec=True)),
    (original_input, lambda value: value["brief"].update(priority=True)),
    (original_input, lambda value: value["editorialItem"].update(priority=True)),
    (original_input, lambda value: value["editorialItem"].update(selectionScore=True)),
    (original_draft, lambda value: value.update(evidenceRefs=("moment-1",))),
    (original_draft, lambda value: value.update(claims=(value["claims"][0],))),
    (original_draft, lambda value: value.update(assumptions=(value["assumptions"][0],))),
    (original_draft, lambda value: value.update(appliedConstraints=(value["appliedConstraints"][0],))),
    (original_draft, lambda value: value.update(addressedIssueIds=())),
    (original_input, lambda value: value.update(referencedMoments=tuple(value["referencedMoments"]))),
    (original_input, lambda value: value.update(referencedAngles=tuple(value["referencedAngles"]))),
    (original_input, lambda value: value.update(constraints=tuple(value["constraints"]))),
    (revise_review, lambda value: value.update(issues=tuple(value["issues"]))),
    (revise_review, lambda value: value["issues"][0].update(evidenceRefs=("moment-1",))),
    (revise_review, lambda value: value["issues"][0].update(constraintRefs=())),
    (revise_review, lambda value: value.update(reviewedAt="2026-08-27 10:00:00Z")),
])
def test_complete_json_boundary_rejects_nested_coercions_and_non_json_lists(factory, mutation):
    payload = deepcopy(factory())
    mutation(payload)
    model = CopywriterInput if factory is original_input else ContentDraft if factory is original_draft else EditorialReview
    with pytest.raises(ValidationError):
        model.model_validate(payload)


@pytest.mark.parametrize(("factory", "mutation"), [
    (original_draft, lambda value: value["claims"][0].update(evidenceRefs=("moment-1",))),
    (original_input, lambda value: value["referencedMoments"][0].update(visualEvidenceIds=("frame-1",))),
    (original_input, lambda value: value["brief"].update(channelCandidates=("x",))),
    (original_input, lambda value: value["brief"].update(formatCandidates=("text_post",))),
    (original_input, lambda value: value["brief"].update(dependencies=())),
    (original_input, lambda value: value["brief"].update(constraints=("Use an evidence-led voice",))),
    (original_input, lambda value: value["brief"].update(evidenceRefs=("moment-1", "angle-1"))),
    (original_input, lambda value: value["editorialItem"].update(evidenceRefs=("moment-1", "angle-1"))),
    (original_input, lambda value: value["editorialItem"].update(dependencies=())),
    (original_input, lambda value: value["editorialItem"].update(constraints=("Use an evidence-led voice",))),
    (original_input, lambda value: value["editorialItem"].update(requiredAssets=())),
])
def test_complete_json_boundary_rejects_tuple_for_every_nested_array(factory, mutation):
    payload = deepcopy(factory())
    mutation(payload)
    model = CopywriterInput if factory is original_input else ContentDraft
    with pytest.raises(ValidationError):
        model.model_validate(payload)


@pytest.mark.parametrize("timestamp", [
    "2026-08-27T10:00Z",
    "2026-08-27T10:00:00Z",
    "2026-08-27T10:00:00.123Z",
    "2026-08-27T10:00+00:00",
    "2026-08-27T10:00:00+00:00",
    "2026-08-27T10:00:00.123+00:00",
])
def test_review_timestamp_accepts_the_same_utc_iso_forms_as_zod(timestamp):
    payload = revise_review()
    payload["reviewedAt"] = timestamp
    assert EditorialReview.model_validate(payload).reviewedAt.isoformat().endswith("+00:00")


def test_copywriter_input_accepts_existing_typed_handoff_models_without_reparsing():
    payload = original_input()
    payload.update({
        "editorialItem": EditorialPlanItem.model_validate(payload["editorialItem"]),
        "brief": ContentBrief.model_validate(payload["brief"]),
        "referencedMoments": [Moment.model_validate(item) for item in payload["referencedMoments"]],
        "referencedAngles": [Angle.model_validate(item) for item in payload["referencedAngles"]],
    })

    result = CopywriterInput.model_validate(payload)
    assert isinstance(result.editorialItem, EditorialPlanItem)
    assert isinstance(result.brief, ContentBrief)
    assert isinstance(result.referencedMoments[0], Moment)
    assert isinstance(result.referencedAngles[0], Angle)


@pytest.mark.parametrize(("field", "value"), [
    ("visualHook", None),
    ("cropSuitability", None),
    ("captionSafeRegion", None),
    ("visualEvidenceIds", None),
])
def test_nested_moment_optional_fields_reject_explicit_null_but_allow_omission(field, value):
    with_null = original_input()
    with_null["referencedMoments"][0][field] = value
    with pytest.raises(ValidationError):
        CopywriterInput.model_validate(with_null)

    omitted = original_input()
    assert CopywriterInput.model_validate(omitted).referencedMoments[0].id == "moment-1"


@pytest.mark.parametrize(("collection", "index"), [
    ("referencedMoments", 0),
    ("referencedAngles", 0),
])
def test_nested_evidence_ids_are_bounded_to_100_characters(collection, index):
    accepted = original_input()
    accepted[collection][index]["id"] = "x" * 100
    if collection == "referencedMoments":
        accepted["editorialItem"]["evidenceRefs"] = ["x" * 100, "angle-1"]
        accepted["brief"]["evidenceRefs"] = ["x" * 100, "angle-1"]
    else:
        accepted["editorialItem"]["evidenceRefs"] = ["moment-1", "x" * 100]
        accepted["brief"]["evidenceRefs"] = ["moment-1", "x" * 100]
    assert CopywriterInput.model_validate(accepted)

    rejected = deepcopy(accepted)
    rejected[collection][index]["id"] = "x" * 101
    if collection == "referencedMoments":
        rejected["editorialItem"]["evidenceRefs"] = ["x" * 101, "angle-1"]
        rejected["brief"]["evidenceRefs"] = ["x" * 101, "angle-1"]
    else:
        rejected["editorialItem"]["evidenceRefs"] = ["moment-1", "x" * 101]
        rejected["brief"]["evidenceRefs"] = ["moment-1", "x" * 101]
    with pytest.raises(ValidationError):
        CopywriterInput.model_validate(rejected)
