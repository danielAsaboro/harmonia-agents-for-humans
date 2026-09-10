"""Real stage worker over local HTTP; only structured inference is supplied offline."""
import asyncio
import json
import sys
from unittest.mock import patch
from tests import conftest  # Offline provider configuration, no provider invocation.
from harmonia_agent import agents
from harmonia_agent.main import _process_stage_event


async def exercise(payload):
    observed = []

    async def structured_output(role, supplied, **_kwargs):
        observed.append(role)
        if role == "noni_artifact_producer":
            text = "Imagine a calmer way to build. What would your team try next?" if "different" in supplied.operatorBrief.lower() else "Imagine your next great workflow. What would you create?"
            return {"semantic_artifact_draft": {"title": "Imagine your next workflow", "sourceSegmentRefs": [], "payloadJson": json.dumps({"kind": "x_post", "text": text})}}
        if role == "dara_artifact_editor":
            return {"semantic_artifact_review": {"decision": "accept", "checks": [{"kind": kind, "passed": True, "note": "Creative invitation makes no factual claims."} for kind in ("grounding", "brief", "brand", "format", "cta", "safety", "clarity")], "issues": []}}
        raise AssertionError(f"Unexpected provider role: {role}")

    with patch.object(agents, "_run_coordinator", side_effect=structured_output):
        acknowledged, result = await _process_stage_event(payload["event"], payload["carrier"], payload["transportId"], payload.get("deliveryAttempt", 1))
    return {"acknowledged": acknowledged, "result": result, "providerRoles": observed}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(exercise(json.load(sys.stdin)))))
