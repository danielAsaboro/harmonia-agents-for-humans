import pytest
from pydantic import ValidationError

from harmonia_agent.a2ui_models import SurfacePlan, UiContext


def context_payload() -> dict:
    return {
        "runId": "run-1",
        "operatorRequest": "Compare the launch drafts.",
        "intent": "list_drafts",
        "job": {
            "id": "job-1",
            "stage": "awaiting_approval",
            "status": "waiting_for_approval",
            "title": "Outcome launch",
            "sourceKind": "video",
        },
        "drafts": [
            {
                "id": "draft-1",
                "platform": "x",
                "valid": True,
                "momentId": "moment-1",
            }
        ],
        "moments": [{"id": "moment-1", "title": "Outcome proof", "startSec": 12, "endSec": 24}],
        "sources": [{"id": "source-video", "kind": "video", "label": "Source video"}],
        "assets": [],
        "actions": [{"id": "action-1", "type": "publish_x_post", "pending": True}],
        "receipts": [],
    }


def test_ui_context_accepts_bounded_reference_summaries() -> None:
    context = UiContext.model_validate(context_payload())

    assert context.job is not None
    assert context.job.id == "job-1"
    assert context.drafts[0].id == "draft-1"


def test_ui_context_requires_a_durable_run_id() -> None:
    payload = context_payload()
    del payload["runId"]

    with pytest.raises(ValidationError):
        UiContext.model_validate(payload)


def test_surface_plan_accepts_only_known_components_and_references() -> None:
    plan = SurfacePlan.model_validate(
        {
            "version": "harmonia.ui/v1",
            "surfaces": [
                {
                    "slot": "canvas",
                    "revision": 1,
                    "rootId": "root",
                    "nodes": [
                        {
                            "id": "root",
                            "component": "DraftComparison",
                            "refs": {"jobId": "job-1", "draftIds": ["draft-1"]},
                            "children": [],
                        }
                    ],
                }
            ],
        }
    )

    assert plan.surfaces[0].nodes[0].refs.draftIds == ["draft-1"]


def test_surface_plan_rejects_authoritative_inline_content() -> None:
    with pytest.raises(ValidationError):
        SurfacePlan.model_validate(
            {
                "version": "harmonia.ui/v1",
                "surfaces": [
                    {
                        "slot": "approval",
                        "revision": 1,
                        "rootId": "root",
                        "nodes": [
                            {
                                "id": "root",
                                "component": "ApprovalReview",
                                "refs": {"jobId": "job-1", "actionIds": ["action-1"]},
                                "children": [],
                                "risk": "low",
                            }
                        ],
                    }
                ],
            }
        )


def test_surface_plan_rejects_dangling_children() -> None:
    with pytest.raises(ValidationError, match="dangling child"):
        SurfacePlan.model_validate(
            {
                "version": "harmonia.ui/v1",
                "surfaces": [
                    {
                        "slot": "canvas",
                        "revision": 1,
                        "rootId": "root",
                        "nodes": [
                            {
                                "id": "root",
                                "component": "CampaignBrief",
                                "refs": {"jobId": "job-1"},
                                "children": ["missing"],
                            }
                        ],
                    }
                ],
            }
        )


@pytest.mark.parametrize(
    "nodes, message",
    [
        (
            [
                {"id": "root", "component": "CampaignBrief", "children": ["child"]},
                {"id": "child", "component": "JobProgress", "children": ["root"]},
            ],
            "cycle",
        ),
        (
            [
                {"id": "root", "component": "CampaignBrief", "children": []},
                {"id": "orphan", "component": "JobProgress", "children": []},
            ],
            "unreachable",
        ),
    ],
)
def test_surface_plan_rejects_unsafe_graph_shapes(nodes: list[dict], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        SurfacePlan.model_validate(
            {
                "version": "harmonia.ui/v1",
                "surfaces": [{"slot": "canvas", "revision": 1, "rootId": "root", "nodes": nodes}],
            }
        )
