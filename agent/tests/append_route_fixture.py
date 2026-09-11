"""Emit the real deterministic Python append classification as an IntentRoute."""

import json
import sys

from harmonia_agent.intent_routing import (
    IntentRoute,
    IntentRoutingInput,
    deterministic_intent_classification,
)


if __name__ == "__main__":
    routing_input = IntentRoutingInput.model_validate(json.load(sys.stdin))
    classification = deterministic_intent_classification(routing_input)
    if classification is None:
        raise RuntimeError("fixture input did not match the deterministic append contract")
    print(IntentRoute.model_validate({
        **classification.model_dump(mode="json"),
        "connectionSuggestions": [],
        "effectAuthorized": False,
        "strategyContext": None,
    }).model_dump_json())
