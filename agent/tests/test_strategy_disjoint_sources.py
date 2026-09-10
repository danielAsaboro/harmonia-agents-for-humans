from copy import deepcopy
import pytest
from harmonia_agent.agents import AgentProtocolError
from tests.strategy_fixtures import source_binding
from harmonia_agent.agent_models import EditorialPlannerInput, EditorialPlan
from harmonia_agent.agents import validate_editorial_plan
from tests.test_temi_editorial_plan import planner_input, plan


def test_second_job_plans_under_immutable_strategy_with_disjoint_source_evidence():
    supplied = planner_input()
    original_strategy = deepcopy(supplied["strategy"])
    supplied["analysis"]["moments"][0].update(id="second-moment", sourceSegmentRefs=["second-source:seg-1"])
    supplied["analysis"]["angles"] = []
    supplied["planningSnapshot"]["sourceBinding"] = source_binding("second-job", supplied["strategyRef"], supplied["analysis"])
    candidate = plan()
    candidate["items"][0]["evidenceRefs"] = ["second-moment"]
    accepted = validate_editorial_plan(EditorialPlannerInput.model_validate(supplied), EditorialPlan.model_validate(candidate))
    assert accepted.items[0].evidenceRefs == ["second-moment"]
    assert supplied["strategy"] == original_strategy


@pytest.mark.parametrize("refs", [["m1"], ["second-source:seg-1"], ["second-moment", "m1"]])
def test_disjoint_job_rejects_origin_or_unanchored_evidence(refs):
    supplied = planner_input()
    supplied["analysis"]["moments"][0].update(id="second-moment", sourceSegmentRefs=["second-source:seg-1"])
    supplied["analysis"]["angles"] = []
    supplied["planningSnapshot"]["sourceBinding"] = source_binding("second-job", supplied["strategyRef"], supplied["analysis"])
    candidate = plan()
    candidate["items"][0]["evidenceRefs"] = refs
    with pytest.raises(AgentProtocolError, match="outside authoritative job sources"):
        validate_editorial_plan(EditorialPlannerInput.model_validate(supplied), EditorialPlan.model_validate(candidate))


def test_changed_analysis_invalidates_binding_without_rewriting_approved_strategy():
    supplied = planner_input()
    supplied["analysis"]["moments"][0]["quote"] = "Changed evidence"
    with pytest.raises(AgentProtocolError, match="job source binding mismatch"):
        validate_editorial_plan(EditorialPlannerInput.model_validate(supplied), EditorialPlan.model_validate(plan()))
