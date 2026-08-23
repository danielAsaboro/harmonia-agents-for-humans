"""ADK evalset loading and private evidence boundaries."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from harmonia_agent.evaluation_runner import EvaluationPrivacyError, load_eval_set


def test_public_evalset_is_adk_pydantic_valid():
    eval_set = load_eval_set(Path("evals/contracts.evalset.json"))

    assert eval_set.eval_set_id == "harmonia-contracts-v1"
    assert {case.eval_id for case in eval_set.eval_cases} >= {
        "route-analyst", "planner-no-authority", "liaison-read-only",
    }


def test_public_evalset_rejects_private_source_material(tmp_path):
    path = tmp_path / "bad.evalset.json"
    path.write_text(json.dumps({
        "eval_set_id": "bad",
        "eval_cases": [{
            "evalId": "leak",
            "conversation": [{
                "userContent": {"parts": [{"text": "raw transcript: secret"}]},
            }],
        }],
    }))

    with pytest.raises(EvaluationPrivacyError, match="private source marker"):
        load_eval_set(path)


@pytest.mark.parametrize("secret", [
    "AIzaSyA_real_looking_key_material_123456",
    "gs://private-harmonia/video.mp4",
    "https://www.youtube.com/watch?v=abc12345678",
])
def test_public_evalset_rejects_credentials_and_media_uris(tmp_path, secret):
    path = tmp_path / "bad.evalset.json"
    path.write_text(json.dumps({
        "eval_set_id": "bad",
        "eval_cases": [{"evalId": "leak", "fixture": secret}],
    }))

    with pytest.raises(EvaluationPrivacyError):
        load_eval_set(path)
