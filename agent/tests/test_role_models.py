from __future__ import annotations

import pytest
from pydantic import ValidationError

from harmonia_agent.role_models import load_role_model_catalog


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
