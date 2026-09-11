import hashlib
import json

import pytest
from pydantic import ValidationError

from harmonia_agent.operator_instructions import validate_operator_instruction_context, validate_provider_instruction_binding


def _context():
    unsigned = {
        "originalOperatorBrief": "Create launch media.",
        "resolvedInstructions": "Create launch media.\n\nUse a copper robot on midnight blue.\n\nDrive waitlist signups.",
        "intakeDraftId": "a" * 64,
        "intakeRevision": 3,
        "answerTurnIds": ["turn-creative", "turn-outcome"],
        "turnProvenance": [
            {"turnId": "turn-initial", "messageDigest": "b" * 64},
            {"turnId": "turn-creative", "messageDigest": "c" * 64},
            {"turnId": "turn-outcome", "messageDigest": "d" * 64, "resolvedField": "expectedOutcome"},
        ],
    }
    digest = hashlib.sha256(json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {**unsigned, "contextDigest": digest}


def test_instruction_context_preserves_first_brief_and_later_answer_turns():
    context = validate_operator_instruction_context(_context())
    assert context["originalOperatorBrief"] == "Create launch media."
    assert "copper robot on midnight blue" in context["resolvedInstructions"]
    assert context["answerTurnIds"] == ["turn-creative", "turn-outcome"]


@pytest.mark.parametrize("change", [
    {"answerTurnIds": ["turn-outcome"]},
    {"contextDigest": "0" * 64},
    {"unexpected": True},
])
def test_instruction_context_rejects_changed_or_extra_provenance(change):
    with pytest.raises(ValidationError):
        validate_operator_instruction_context({**_context(), **change})


@pytest.mark.parametrize("provider", ["nova_canvas", "nova_reel", "elevenlabs"])
def test_each_paid_provider_prompt_is_bound_to_the_same_resolved_instructions(provider):
    context = _context()
    sealed = {"provider": provider, "model": "model", "request": {"prompt": context["resolvedInstructions"]}, "instructionContext": context}
    assert validate_provider_instruction_binding(sealed) == context
    with pytest.raises(ValueError, match="prompt differs"):
        validate_provider_instruction_binding({**sealed, "request": {"prompt": "First turn only"}})
