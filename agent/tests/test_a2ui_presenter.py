from __future__ import annotations

import asyncio

import pytest

from harmonia_agent.a2ui_models import UiContext
from harmonia_agent.a2ui_presenter import plan_surface
from harmonia_agent.agents import AgentProtocolError, build_agent_team
from harmonia_agent.usage import InvocationContext


def context_fixture() -> UiContext:
    return UiContext.model_validate(
        {
            "runId": "run-1",
            "operatorRequest": "Show the strongest moments.",
            "intent": "status",
            "job": {
                "id": "job-1",
                "stage": "understand",
                "status": "running",
                "title": "Launch interview",
                "sourceKind": "video",
            },
            "drafts": [],
            "moments": [
                {"id": "moment-1", "title": "Outcome proof", "startSec": 12, "endSec": 24}
            ],
            "sources": [{"id": "source-video", "kind": "video", "label": "Source video"}],
            "assets": [],
            "actions": [],
            "receipts": [],
        }
    )


def invocation_fixture() -> InvocationContext:
    return InvocationContext(
        job_id="job-1",
        workspace_id="workspace-1",
        brand_id="brand-1",
        user_id="operator-1",
        stage="presentation",
        operation_id="present-run-1",
    )


class FakeTeamRuntime:
    def __init__(self, state: dict) -> None:
        self.state = state
        self.calls: list[dict] = []

    async def invoke(self, **kwargs):
        self.calls.append(kwargs)
        return self.state


def valid_surface_state() -> dict:
    return {
        "surface_plan": {
            "version": "harmonia.ui/v1",
            "surfaces": [
                {
                    "slot": "canvas",
                    "revision": 1,
                    "rootId": "root",
                    "artDirection": {
                        "rhythm": "cinematic",
                        "composition": "split",
                        "energy": "active",
                    },
                    "nodes": [
                        {
                            "id": "root",
                            "component": "MomentExplorer",
                            "refs": {"jobId": "job-1", "momentIds": ["moment-1"]},
                            "artDirection": {
                                "tone": "blue",
                                "role": "feature",
                                "density": "balanced",
                                "motion": "trace",
                            },
                            "children": [],
                        }
                    ],
                }
            ],
        }
    }


def test_plan_surface_uses_managed_runtime_and_validates_output() -> None:
    runtime = FakeTeamRuntime(valid_surface_state())
    reservations: list[dict] = []
    usage: list[dict] = []

    result = asyncio.run(
        plan_surface(
            context_fixture(),
            invocation=invocation_fixture(),
            team_runtime=runtime,
            budget_reserver=reservations.append,
            usage_reporter=usage.append,
        )
    )

    assert result.surfaces[0].nodes[0].component == "MomentExplorer"
    assert result.surfaces[0].artDirection.rhythm == "cinematic"
    assert result.surfaces[0].nodes[0].artDirection.tone == "blue"
    assert runtime.calls[0]["specialist"] == "maya_presenter"
    assert runtime.calls[0]["user_id"] == "workspace-1:operator-1:job-1"
    assert [record["role"] for record in reservations] == [
        "harmonia_coordinator",
        "maya_presenter",
    ]
    assert [record["role"] for record in usage] == [
        "harmonia_coordinator",
        "maya_presenter",
    ]


def test_plan_surface_rejects_invalid_managed_output() -> None:
    runtime = FakeTeamRuntime({"surface_plan": {"version": "harmonia.ui/v1", "surfaces": []}})

    with pytest.raises(AgentProtocolError, match="invalid agent output"):
        asyncio.run(
            plan_surface(
                context_fixture(),
                invocation=invocation_fixture(),
                team_runtime=runtime,
                budget_reserver=lambda _record: None,
                usage_reporter=lambda _record: None,
            )
        )


def test_plan_surface_rejects_arbitrary_color_output() -> None:
    state = valid_surface_state()
    state["surface_plan"]["surfaces"][0]["nodes"][0]["artDirection"]["tone"] = "#00ff00"
    runtime = FakeTeamRuntime(state)

    with pytest.raises(AgentProtocolError, match="invalid agent output"):
        asyncio.run(
            plan_surface(
                context_fixture(),
                invocation=invocation_fixture(),
                team_runtime=runtime,
                budget_reserver=lambda _record: None,
                usage_reporter=lambda _record: None,
            )
        )


def test_presenter_instruction_defines_semantic_art_direction() -> None:
    presenter = next(agent for agent in build_agent_team().sub_agents if agent.name == "maya_presenter")
    instruction = str(presenter.instruction)

    assert "Use ink for strategy" in instruction
    assert "acid for a selected creative direction or persisted verified success" in instruction
    assert "never emit style values" in instruction
    assert "Prefer one hero or feature per surface" in instruction
