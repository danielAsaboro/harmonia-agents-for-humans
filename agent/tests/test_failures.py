import asyncio

import httpx
from pydantic import BaseModel, ValidationError

from harmonia_agent.agents import AgentProtocolError
from harmonia_agent.failures import FailureCategory, normalize_failure
from harmonia_agent.generative_media import MediaProviderError
from harmonia_agent.memory_bank import MemoryProviderError
from harmonia_agent.model_catalog import UnknownModelPrice
from harmonia_agent.web_client import WebApiError
from harmonia_agent.x_client import XError
from harmonia_agent import stages


def envelope(exc: Exception, *, attempt: int = 0):
    return normalize_failure(
        exc,
        stage="draft",
        operation_id="job-1:draft:0",
        trace_id="a" * 32,
        attempt=attempt,
    )


def test_normalizes_every_required_failure_category():
    class Required(BaseModel):
        value: int

    try:
        Required.model_validate({"value": "not-an-int"})
    except ValidationError as exc:
        validation = exc

    request = httpx.Request("GET", "https://provider.example")
    cases = [
        (validation, FailureCategory.VALIDATION),
        (WebApiError("Bearer super-secret", 401), FailureCategory.AUTHORIZATION),
        (MediaProviderError("filtered content", permanent=True), FailureCategory.PROVIDER_PERMANENT),
        (UnknownModelPrice("model with no price"), FailureCategory.BUDGET),
        (httpx.ConnectTimeout("token=super-secret", request=request), FailureCategory.PROVIDER_TRANSIENT),
        (XError("provider body super-secret", 400), FailureCategory.PROVIDER_PERMANENT),
        (MemoryProviderError("backend unavailable"), FailureCategory.DEPENDENCY),
        (AgentProtocolError("raw model output super-secret"), FailureCategory.PROTOCOL),
    ]

    for exc, expected in cases:
        result = envelope(exc)
        assert result.category == expected
        assert result.stage == "draft"
        assert result.operation_id == "job-1:draft:0"
        assert result.trace_id == "a" * 32
        assert "super-secret" not in result.model_dump_json()


def test_policy_failure_is_explicit_and_never_retryable():
    result = normalize_failure(
        PermissionError("operator approval required"),
        stage="publish",
        operation_id="job-1:publish:0",
        trace_id="b" * 32,
        attempt=0,
        category=FailureCategory.POLICY,
        code="approval_required",
    )
    assert result.category == FailureCategory.POLICY
    assert result.retryable is False
    assert result.public_message == "Operator or policy action is required before this stage can continue."


def test_retryable_failures_stop_after_the_central_attempt_limit():
    request = httpx.Request("GET", "https://provider.example")
    exc = httpx.ReadTimeout("temporary", request=request)
    assert envelope(exc, attempt=0).retryable is True
    exhausted = envelope(exc, attempt=2)
    assert exhausted.retryable is False
    assert exhausted.max_attempts == 3
    assert exhausted.code == "provider_timeout"


def test_unknown_exception_is_safe_bounded_dependency_failure():
    result = envelope(RuntimeError("cookie=super-secret and private response body"))
    assert result.category == FailureCategory.DEPENDENCY
    assert result.retryable is True
    assert result.public_message == "A required dependency is temporarily unavailable."
    assert result.details == {"exceptionType": "RuntimeError"}


def test_dispatch_reports_typed_failure_and_nacks_only_within_retry_limit(monkeypatch):
    reports = []

    async def fail(_job_id):
        raise httpx.ReadTimeout("token=super-secret", request=httpx.Request("GET", "https://provider.example"))

    monkeypatch.setitem(stages.HANDLERS, "draft", fail)
    monkeypatch.setattr(stages, "web_post", lambda path, body: reports.append((path, body)))

    assert asyncio.run(stages.dispatch("job-1", "draft", attempt=0)) is False
    first = reports[-1][1]
    assert first["category"] == "provider_transient"
    assert first["retryable"] is True
    assert first["operationId"] == "job-1:draft:0"
    assert "super-secret" not in str(first)

    assert asyncio.run(stages.dispatch("job-1", "draft", attempt=2)) is True
    assert reports[-1][1]["retryable"] is False
