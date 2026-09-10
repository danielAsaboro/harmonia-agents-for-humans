"""Exercise the real routing host with local specialist/connection boundaries."""
import asyncio
import json
import sys
from tests import conftest  # initialize local-only configuration before agent imports
from harmonia_agent import agents
from harmonia_agent.intent_routing import IntentRoutingInput, source_urls_from_input
from tests.test_intent_routing import strategy_context

value = IntentRoutingInput.model_validate(json.load(sys.stdin))

async def specialist(name, payload, **kwargs):
    if name == "harmonia_context_assembler":
        return {"intent_strategy_context": strategy_context()}
    return {"intent_classification": {"intent": "one_off_content", "workPlacement": "independent",
        "userOutcome": "Recruit founders", "sourceUrls": source_urls_from_input(value),
        "outputConcepts": ["short_social_post"], "platformRecommendations": [], "assumptions": [],
        "needsClarification": value.message.startswith("Clarify"),
        "missingField": "expectedOutcome" if value.message.startswith("Clarify") else None,
        "clarifyingQuestion": "What outcome should this announcement achieve?" if value.message.startswith("Clarify") else None,
        "resolvedField": "expectedOutcome" if value.pendingClarification and value.message.startswith("Recruit") else None,
        "requiresRightsAttestation": False,
        "effectRequested": False}}

agents._run_coordinator = specialist
agents.get_social_platform_connections = lambda: {"status": "success", "data": {"platforms": []}}
print(asyncio.run(agents.route_intent_with_team(value)).model_dump_json())
