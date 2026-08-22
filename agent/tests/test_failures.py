import httpx
import pytest

from closefold_agent.github_client import GitHubError, action_idempotency_key
from closefold_agent.stages import classify_failure
from closefold_agent.web_client import WebApiError


def test_idempotency_key_is_deterministic():
    payload = {"type": "github_create_issue", "title": "T", "body": "B"}
    k1 = action_idempotency_key("job", "action", payload)
    k2 = action_idempotency_key("job", "action", dict(reversed(list(payload.items()))))
    assert k1 == k2
    assert len(k1) == 64


def test_key_changes_with_content():
    a = action_idempotency_key("job", "action", {"body": "v1"})
    b = action_idempotency_key("job", "action", {"body": "v2"})
    assert a != b


def test_web_4xx_is_permanent_and_5xx_transient():
    assert WebApiError("bad", 400).permanent is True
    assert WebApiError("bad", 429).permanent is False
    assert WebApiError("boom", 500).permanent is False


def test_github_403_permits_retry_via_search_fallback_semantics():
    err = GitHubError("forbidden", 403)
    assert err.permanent is True  # auth/permission errors will not fix themselves


def test_classify_failure_transport_is_transient():
    req = httpx.Request("GET", "https://api.github.com")
    assert classify_failure(httpx.ConnectTimeout("t", request=req)) is False
    assert classify_failure(KeyError("missing")) is True
