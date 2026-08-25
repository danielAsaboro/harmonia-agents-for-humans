from __future__ import annotations

from decimal import Decimal

import pytest
from pydantic import ValidationError

from harmonia_agent.role_models import RoleGenerationPolicy, load_role_model_catalog


def test_roles_do_not_collapse_to_one_global_model(monkeypatch):
    monkeypatch.setenv("COORDINATOR_MODEL_ID", "gemini-3.5-flash-lite")
    monkeypatch.setenv("STRATEGIST_MODEL_ID", "gemini-3.5-flash")
    monkeypatch.setenv("ANALYST_MODEL_ID", "gemini-3.5-flash")
    monkeypatch.setenv("COPYWRITER_MODEL_ID", "gemma-3-12b-it")
    monkeypatch.setenv("EDITOR_MODEL_ID", "gemini-3.5-flash")
    monkeypatch.setenv("PLANNER_MODEL_ID", "gemini-3.5-flash-lite")
    monkeypatch.setenv("PRESENTER_MODEL_ID", "gemini-3.5-flash")
    monkeypatch.setenv(
        "GEMMA_VERTEX_ENDPOINT",
        "projects/p/locations/us-central1/endpoints/123",
    )

    catalog = load_role_model_catalog()

    assert catalog.coordinator.model_id == "gemini-3.5-flash-lite"
    assert catalog.copywriter.provider == "vertex_endpoint"
    assert catalog.copywriter.endpoint.endswith("/endpoints/123")
    assert catalog.presenter.model_id == "gemini-3.5-flash"
    assert len({item.model_id for item in catalog.roles()}) >= 3


def test_gemma_role_requires_a_concrete_vertex_endpoint(monkeypatch):
    monkeypatch.setenv("COPYWRITER_MODEL_ID", "gemma-3-12b-it")
    monkeypatch.delenv("GEMMA_VERTEX_ENDPOINT", raising=False)

    with pytest.raises(ValidationError, match="endpoint"):
        load_role_model_catalog()


def test_copywriter_can_use_explicit_gemini_core_mode(monkeypatch):
    monkeypatch.setenv("COPYWRITER_PROVIDER", "gemini")
    monkeypatch.setenv("COPYWRITER_MODEL_ID", "gemini-3.5-flash")
    monkeypatch.delenv("GEMMA_VERTEX_ENDPOINT", raising=False)

    catalog = load_role_model_catalog()

    assert catalog.copywriter.provider == "gemini"
    assert catalog.copywriter.model_id == "gemini-3.5-flash"
    assert catalog.copywriter.endpoint is None
    assert catalog.copywriter.reservation_usd is None


def test_every_role_has_versioned_generation_and_safety_policy(monkeypatch):
    """Catches a role falling back to implicit provider generation defaults."""
    monkeypatch.setenv(
        "GEMMA_VERTEX_ENDPOINT",
        "projects/p/locations/us-central1/endpoints/123",
    )

    catalog = load_role_model_catalog()

    assert all(role.policy_version == "gear-2026-08-24" for role in catalog.roles())
    assert catalog.planner.generation.temperature == 0.1
    assert catalog.analyst.generation.temperature == 0.2
    assert catalog.copywriter.generation.temperature == 0.8
    assert all(
        role.generation.safety_profile == "harmonia-standard"
        for role in catalog.roles()
    )
    assert all(role.timeout_seconds > 0 for role in catalog.roles())
    assert all(role.eligible_tasks for role in catalog.roles())
    assert all(role.minimum_pass_rate == Decimal("0.95") for role in catalog.roles())
    assert all(role.pricing_version == "2026-08-23" for role in catalog.roles())


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("temperature", 2.1),
        ("temperature", -0.1),
        ("top_p", 0),
        ("top_p", 1.1),
        ("top_k", 0),
    ],
)
def test_generation_policy_rejects_unbounded_values(field, value):
    """Catches an invalid sampling value reaching a provider request."""
    values = {
        "temperature": 0.2,
        "top_p": 0.9,
        "top_k": 40,
        "safety_profile": "harmonia-standard",
    }
    values[field] = value

    with pytest.raises(ValidationError):
        RoleGenerationPolicy(**values)
