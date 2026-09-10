from __future__ import annotations

from decimal import Decimal

import pytest
from pydantic import ValidationError

from harmonia_agent.role_models import RoleGenerationPolicy, load_role_model_catalog
from harmonia_agent.generation_policy import generation_config


def test_roles_do_not_collapse_to_one_global_model(monkeypatch):
    monkeypatch.setenv("COORDINATOR_MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0")
    monkeypatch.setenv("STRATEGIST_MODEL_ID", "us.anthropic.claude-sonnet-4-6")
    monkeypatch.setenv("ANALYST_MODEL_ID", "us.anthropic.claude-sonnet-4-6")
    monkeypatch.setenv("COPYWRITER_MODEL_ID", "us.anthropic.claude-sonnet-4-6")
    monkeypatch.setenv("EDITOR_MODEL_ID", "us.anthropic.claude-sonnet-4-6")
    monkeypatch.setenv("PLANNER_MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0")
    monkeypatch.setenv("PRESENTER_MODEL_ID", "us.anthropic.claude-sonnet-4-6")

    catalog = load_role_model_catalog()

    assert catalog.coordinator.model_id == "us.anthropic.claude-haiku-4-5-20251001-v1:0"
    assert catalog.copywriter.provider == "bedrock"
    assert catalog.copywriter.model_id == "us.anthropic.claude-sonnet-4-6"
    assert catalog.copywriter.endpoint is None
    assert catalog.presenter.model_id == "us.anthropic.claude-sonnet-4-6"
    assert len({item.model_id for item in catalog.roles()}) >= 2


def test_copywriter_uses_skill_capable_gemini(monkeypatch):
    monkeypatch.setenv("COPYWRITER_MODEL_ID", "us.anthropic.claude-sonnet-4-6")

    catalog = load_role_model_catalog()

    assert catalog.copywriter.provider == "bedrock"
    assert catalog.copywriter.model_id == "us.anthropic.claude-sonnet-4-6"
    assert catalog.copywriter.endpoint is None
    assert catalog.copywriter.reservation_usd is None


def test_each_role_can_raise_its_timeout_without_weakening_other_roles(monkeypatch):
    monkeypatch.setenv("STRATEGIST_TIMEOUT_SECONDS", "300")

    catalog = load_role_model_catalog()

    assert catalog.strategist.timeout_seconds == 300
    assert catalog.analyst.timeout_seconds == 120


def test_every_role_has_versioned_generation_and_safety_policy(monkeypatch):
    """Catches a role falling back to implicit provider generation defaults."""

    catalog = load_role_model_catalog()

    assert all(role.policy_version == "strands-2026-09-09" for role in catalog.roles())
    assert catalog.planner.generation.temperature == 0.1
    assert catalog.planner.max_output_tokens == 8192
    assert catalog.analyst.generation.temperature == 0.2
    assert catalog.copywriter.generation.temperature == 0.8
    assert all(
        role.generation.safety_profile == "harmonia-standard"
        for role in catalog.roles()
    )
    assert all(role.timeout_seconds > 0 for role in catalog.roles())
    assert all(role.eligible_tasks for role in catalog.roles())
    assert catalog.planner.eligible_tasks == ("propose_editorial_plan",)
    assert all(role.minimum_pass_rate == Decimal("0.95") for role in catalog.roles())
    assert all(role.pricing_version == "aws-configured-2026-09-10" for role in catalog.roles())


def test_native_bedrock_generation_uses_one_sampling_parameter():
    role = load_role_model_catalog().analyst
    config = generation_config(role)
    assert role.model_id == "us.amazon.nova-2-lite-v1:0"
    assert config == {"max_tokens": role.max_output_tokens, "temperature": role.generation.temperature}



def test_strategist_has_enough_time_to_complete_the_strategy_contract():
    """Catches the worker cancelling Ryan at the former 120-second limit."""

    catalog = load_role_model_catalog()

    assert catalog.strategist.timeout_seconds == 300


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


def test_native_runtime_has_no_hidden_agent_retry_policy():
    from pathlib import Path
    runtime = (Path(__file__).parents[1] / "harmonia_agent/team_runtime.py").read_text()
    assert "retry_strategy=None" in runtime
    assert "self.calls > self.max_calls" in runtime
