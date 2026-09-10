"""Provider-free structured outputs for the real Dynamo strategy admission test."""
import asyncio
from copy import deepcopy
from datetime import datetime, timedelta
import json
import sys
from unittest.mock import patch
from tests import conftest  # Loads only offline test settings.

from harmonia_agent import agents, stages
from harmonia_agent.operation_context import operation_scope
from tests.test_temi_editorial_plan import plan


def exercise(payload):
    job = payload["job"]
    original_strategy = deepcopy(job["contentStrategy"])
    snapshot = payload["snapshot"]
    posts, observed = [], []

    async def structured_output(role, supplied, **_kwargs):
        observed.append({"role": role, "input": supplied.model_dump(mode="json", exclude_none=True)})
        if role == "temi_editorial_planner":
            candidate = plan()
            brief = job["contentStrategy"]["briefs"][0]
            start = datetime.fromisoformat(snapshot["snapshot"]["horizonStartAt"].replace("Z", "+00:00"))
            stamp = lambda hours: (start + timedelta(hours=hours)).isoformat().replace("+00:00", "Z")
            candidate.update(approvedStrategyDigest=job["strategyRef"]["digest"], planningSnapshotId=snapshot["snapshot"]["snapshotId"], planningSnapshotDigest=snapshot["digest"], horizonStartAt=snapshot["snapshot"]["horizonStartAt"], horizonEndAt=snapshot["snapshot"]["horizonEndAt"], timezone=snapshot["snapshot"]["timezone"])
            item = candidate["items"][0]
            item.update({key: brief[key] for key in ("objective", "audienceId", "funnelStage", "intendedConversion", "ctaIntent", "kpi", "constraints")})
            item.update(briefId=brief["id"], campaignTheme=job["contentStrategy"]["campaignThemes"][0]["name"], contentPillar=job["contentStrategy"]["pillars"][0]["name"], evidenceRefs=["second-moment"], requiredAssets=[], publicationWindowStartAt=stamp(24), publicationWindowEndAt=stamp(25), productionDeadlineAt=stamp(12))
            return {"editorial_plan": candidate}
        if role == "noni_artifact_producer":
            return {"semantic_artifact_draft": {"title": "Second job proof", "sourceSegmentRefs": ["second-source:seg-1"], "payloadJson": json.dumps({"kind": "x_post", "text": "Second source proof. Request a demo."})}}
        if role == "dara_artifact_editor":
            return {"semantic_artifact_review": {"decision": "accept", "checks": [{"kind": kind, "passed": True, "note": "Grounded in the supplied second source."} for kind in ("grounding", "brief", "brand", "format", "cta", "safety", "clarity")], "issues": []}}
        raise AssertionError(role)

    def post(path, value):
        posts.append({"path": path, "payload": value})
        return {"outcome": "execute"} if path.endswith("/claim") else {"ok": True}

    with patch.object(stages, "get_job", return_value=job), patch.object(stages, "get_editorial_planning_snapshot", return_value=snapshot), patch.object(stages, "get_source_manifest", return_value={"normalizedSources": [{"sourceId": "second-source", "segments": [{"id": "provider-id", "text": "Second source proof."}]}]}), patch.object(stages, "web_post", side_effect=post), patch.object(agents, "_run_coordinator", side_effect=structured_output):
        with operation_scope(f"job:{job['id']}:stage:{payload['stage']}:generation:1", 1):
            asyncio.run(getattr(stages, f"run_{payload['stage']}")(job["id"]))
    assert job["contentStrategy"] == original_strategy
    return {"posts": posts, "observed": observed}


if __name__ == "__main__":
    print(json.dumps(exercise(json.load(sys.stdin))))
