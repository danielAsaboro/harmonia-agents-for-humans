"""Real stage worker over local HTTP; only structured inference is supplied offline."""
import asyncio
import json
import os
import sys
from unittest.mock import patch
from tests import conftest  # Offline provider configuration, no provider invocation.
from harmonia_agent import agents
from harmonia_agent import stages
from harmonia_agent.main import _process_stage_event


async def exercise(payload):
    observed = []

    async def structured_output(role, supplied, **_kwargs):
        observed.append(role)
        if role == "ryan_strategist":
            # Local controlled inference boundary: the normal stage still serializes
            # StrategistInput, validates the result, and persists through TS routes.
            from tests.test_ryan_strategy import strategy
            candidate = strategy().model_dump(mode="json")
            candidate["audiencePriorities"][0]["audienceId"] = "founders"
            candidate["briefs"][0]["audienceId"] = "founders"
            candidate["briefs"][0]["channelCandidates"] = ["x"]
            candidate["channelRoles"] = [role for role in candidate["channelRoles"] if role["channel"] == "x"]
            for key in ("objectives", "audiencePriorities", "pillars", "campaignThemes", "channelRoles", "kpis", "briefs", "assumptions"):
                for item in candidate[key]:
                    item["evidenceRefs"] = ["context:company", "context:campaign"]
            return {"strategist_result": {"strategy": candidate}}
        if role == "noni_artifact_producer":
            text = "Imagine a calmer way to build. What would your team try next?" if "different" in supplied.operatorBrief.lower() else "Imagine your next great workflow. What would you create?"
            return {"semantic_artifact_draft": {"title": "Imagine your next workflow", "sourceSegmentRefs": [], "payloadJson": json.dumps({"kind": "x_post", "text": text})}}
        if role == "dara_artifact_editor":
            return {"semantic_artifact_review": {"decision": "accept", "checks": [{"kind": kind, "passed": True, "note": "Creative invitation makes no factual claims."} for kind in ("grounding", "brief", "brand", "format", "cta", "safety", "clarity")], "issues": []}}
        raise AssertionError(f"Unexpected provider role: {role}")

    def local_failure_adapters(*_args, **_kwargs):
        def lose_provider_response(_payload, _context):
            raise RuntimeError("local controlled provider response loss after dispatch")
        return {"publish_x_post": lose_provider_response}

    patches = [patch.object(agents, "_run_coordinator", side_effect=structured_output)]
    if os.environ.get("HARMONIA_LOCAL_EFFECT_RESPONSE_LOSS") == "true":
        patches.append(patch.object(stages, "production_adapters", side_effect=local_failure_adapters))
    with patches[0]:
        with patches[1] if len(patches) > 1 else __import__("contextlib").nullcontext():
            acknowledged, result = await _process_stage_event(payload["event"], payload["carrier"], payload["transportId"], payload.get("deliveryAttempt", 1))
    return {"acknowledged": acknowledged, "result": result, "providerRoles": observed}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(exercise(json.load(sys.stdin)))))
