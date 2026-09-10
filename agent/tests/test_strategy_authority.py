import pytest
from pydantic import ValidationError
from harmonia_agent.agent_models import EditorialPlannerInput
from tests.test_temi_editorial_plan import planner_input
from harmonia_agent.content_artifacts import ArtifactProductionInput


def test_artifact_specialist_requires_pinned_strategy_ref():
    value = {"outputPlanId": "plan-1", "outputPlanDigest": "a" * 64, "requests": [{"id": "output", "outputType": "newsletter", "evidenceRefs": ["source"]}], "evidence": [{"id": "source", "text": "Proof"}], "brandContext": "Factual", "constraints": [], "passType": "original", "priorBatch": None, "priorReview": None}
    with pytest.raises(ValidationError, match="strategyRef"):
        ArtifactProductionInput.model_validate(value)


def test_planner_requires_pinned_strategy_ref():
    payload = planner_input()
    payload.pop("strategyRef", None)
    with pytest.raises(ValidationError, match="strategyRef"):
        EditorialPlannerInput.model_validate(payload)


def test_planner_binds_ref_digest_identity_and_unbounded_lifetime_revision():
    payload = planner_input()
    payload["strategyRef"] = {"workspaceId": "workspace", "brandId": "brand", "strategyId": payload["strategy"]["strategyId"], "revision": 37, "digest": payload["strategyDigest"]}
    parsed = EditorialPlannerInput.model_validate(payload)
    assert parsed.strategyRef.revision == 37
    payload["strategyRef"]["digest"] = "0" * 64
    with pytest.raises(ValidationError, match="strategy reference"):
        EditorialPlannerInput.model_validate(payload)
