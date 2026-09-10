"""Local contract fixture: emits actual Pydantic route/strategy input serialization."""
import json
import sys
from harmonia_agent.intent_routing import IntentRoute
from tests.test_intent_routing import strategy_context

if __name__ == "__main__":
    if len(sys.argv) > 1:
        from harmonia_agent.stages import _strategy_input
        print(_strategy_input(json.load(sys.stdin), {}).model_dump_json())
    else:
        print(IntentRoute(intent="establish_strategy", workPlacement="new_initiative", targetName=None,
            userOutcome="Educate founders", sourceUrls=[], outputConcepts=[], platformRecommendations=["linkedin"],
            connectionSuggestions=[], assumptions=[], needsClarification=False, clarifyingQuestion=None,
            requiresRightsAttestation=False, effectRequested=False, effectAuthorized=False, jobId=None,
            strategyContext=strategy_context()).model_dump_json())
