"""Managed Google ADK presentation-agent boundary for Harmonia A2UI."""

from __future__ import annotations

from collections.abc import Callable

from .a2ui_models import SurfacePlan, UiContext
from .agents import _run_coordinator, _validated_state
from .team_runtime import TeamRuntime
from .usage import InvocationContext
from .web_client import report_usage, reserve_budget


async def plan_surface(
    context: UiContext,
    *,
    invocation: InvocationContext,
    team_runtime: TeamRuntime | None = None,
    budget_reserver: Callable[[dict[str, object]], None] = reserve_budget,
    usage_reporter: Callable[[dict[str, object]], None] = report_usage,
) -> SurfacePlan:
    """Generate and validate one reference-only presentation plan."""
    validated = UiContext.model_validate(context)
    state = await _run_coordinator(
        "maya_presenter",
        validated,
        invocation=invocation,
        team_runtime=team_runtime,
        budget_reserver=budget_reserver,
        usage_reporter=usage_reporter,
    )
    return _validated_state(state, "surface_plan", SurfacePlan)
