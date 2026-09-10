import pytest
from harmonia_agent.canonical import typed_digest
from harmonia_agent.source_binding import validate_source_binding


def test_no_source_binding_keeps_operator_brief_out_of_evidence():
    ref = {"workspaceId": "w", "brandId": "b", "strategyId": "s", "revision": 1, "digest": "a" * 64}
    context = {"mode": "operator_context", "operatorBrief": "Imagine a creative workflow", "contextDigest": typed_digest("Imagine a creative workflow"), "evidenceIds": [], "factualClaimsAllowed": False}
    binding = {**context, "jobId": "j", "strategyRef": ref}
    validate_source_binding(binding, "j", ref, None, [{"evidenceRefs": []}], operator_context=context)
    with pytest.raises(ValueError, match="evidence"):
        validate_source_binding(binding, "j", ref, None, [{"evidenceRefs": ["invented:fact"]}], operator_context=context)
    with pytest.raises(ValueError, match="context"):
        validate_source_binding(binding, "j", ref, None, [], operator_context={**context, "operatorBrief": "Changed"})


def test_missing_source_does_not_implicitly_authorize_source_free_work():
    with pytest.raises(ValueError, match="authority"):
        validate_source_binding({}, "j", {}, None, [])
