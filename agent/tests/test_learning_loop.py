import asyncio
import json
from unittest.mock import patch

import httpx
import pytest

from harmonia_agent import stages, x_client


def test_missing_x_metric_is_unavailable_not_zero():
    class Client:
        def __enter__(self): return self
        def __exit__(self, *_): return None
        def get(self, *_args, **_kwargs):
            return httpx.Response(200, json={"data": {"id": "42", "public_metrics": {"like_count": 1}}})
    with patch.object(x_client.httpx, "Client", return_value=Client()):
        assert x_client.get_post_metrics("42", "token") is None


def test_learn_does_not_call_paid_metrics_or_invent_winning_patterns():
    job = {"id": "job", "workspaceId": "w", "brandId": "b", "createdByUserId": "operator", "actions": [{"id": "a", "type": "publish_x_post", "state": "executed", "payload": {"text": "One post"}}]}
    posts = []
    with patch.object(stages, "get_job", return_value=job), patch.object(stages, "_receipts_for_job", return_value=[{"actionId": "a", "detail": {"id": "42"}}]), patch.object(stages, "get_connection", return_value={"accessToken": "token"}), patch.object(stages.x_client, "get_post_metrics", side_effect=AssertionError("metrics must wait for pinned collection window")), patch.object(stages, "configured_memory", return_value=None), patch.object(stages, "web_post", side_effect=lambda path, body: posts.append((path, body))):
        asyncio.run(stages.run_learn("job"))
    assert posts[-1][1]["engagement"] == []
    assert "winning" not in json.dumps(posts[-1][1]).lower()
    assert "window" in posts[-1][1]["learnings"]["summary"].lower()


def test_learning_context_is_strict_and_serializes_for_host():
    from harmonia_agent import learning_models
    context = learning_models.LearningContext.model_validate({"authority": "host_persisted", "memoryAuthority": "derived_recall_only", "observations": [], "evaluations": [], "proposals": []})
    assert context.model_dump(mode="json")["authority"] == "host_persisted"
    with pytest.raises(ValueError):
        learning_models.LearningContext.model_validate({**context.model_dump(), "mayApprove": True})

def test_scheduled_metric_failure_is_reported_as_unresolved_without_zero():
    from harmonia_agent import learning_collector
    collection = {"id": "a" * 64, "token": "b" * 64, "postId": "42", "costAuthorization": {"maximumUsd": "0.01"}}
    result = learning_collector.collect_observation(collection, fetch=lambda _: (_ for _ in ()).throw(httpx.ReadTimeout("response unknown")))
    assert result["outcome"] == "unknown"
    assert result["metrics"] is None
    absent = learning_collector.collect_observation(collection, fetch=lambda _: None)
    assert absent["outcome"] == "unavailable"
    assert absent["metrics"] is None
    rejected = learning_collector.collect_observation(collection, fetch=lambda _: (_ for _ in ()).throw(x_client.XError("Permission denied", 403)))
    assert rejected["outcome"] == "failed"
    assert rejected["reason"].endswith("403")

def test_one_unknown_persistence_response_does_not_abandon_other_claimed_collections():
    from harmonia_agent import learning_collector
    observed = []
    class Client:
        def __enter__(self): return self
        def __exit__(self, *_): return None
        def get(self, *_): return httpx.Response(200, json={"collections": [{"id": key * 64, "token": "c" * 64, "postId": key, "costAuthorization": {"maximumUsd": "0.01"}} for key in ["a", "b"]]})
        def post(self, _path, *, json): observed.append(json); return httpx.Response(503, json={})
    with patch.object(learning_collector, "_client", return_value=Client()), patch.object(learning_collector, "get_connection", return_value={"accessToken": "offline"}), patch.object(x_client, "get_post_metrics", return_value={"likes": 1, "replies": 0, "reposts": 0, "quotes": 0}):
        with pytest.raises(learning_collector.WebApiError): learning_collector.tick_learning()
    assert [result["collectionId"] for result in observed] == ["a" * 64, "b" * 64]

def test_learning_outage_does_not_block_other_scheduled_work():
    from harmonia_agent import scheduler, learning_collector
    completed = []
    with patch.object(learning_collector, "tick_learning", side_effect=learning_collector.WebApiError("offline", 503)), patch.object(scheduler, "run_library_sync_tick", side_effect=lambda: completed.append("libraries")), patch.object(scheduler, "get_due_effect_command_ids", return_value=[]):
        asyncio.run(scheduler._tenant_tick())
    assert completed == ["libraries"]
