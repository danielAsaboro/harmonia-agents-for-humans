"""ADK evalset loading and private evidence boundaries."""

from __future__ import annotations

import json
import asyncio
from pathlib import Path

import pytest

from harmonia_agent.evaluation_runner import (
    EvaluationPrivacyError,
    load_eval_set,
    run_live_eval,
    validate_eval_set_privacy,
)


def test_public_evalset_is_adk_pydantic_valid():
    eval_set = load_eval_set(Path("evals/contracts.evalset.json"))

    assert eval_set.eval_set_id == "harmonia-contracts-v1"
    assert {case.eval_id for case in eval_set.eval_cases} >= {
        "route-analyst", "planner-no-authority", "liaison-read-only",
    }
    validate_eval_set_privacy(eval_set)


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


def test_public_evalset_rejects_unlisted_fixture_and_short_freeform_prompt(tmp_path):
    path = tmp_path / "bad.evalset.json"
    path.write_text(json.dumps({
        "eval_set_id": "bad",
        "eval_cases": [{
            "evalId": "route-analyst",
            "fixture": "public:route:sophia_analyst",
            "conversation": [{
                "userContent": {"parts": [{"text": "A short but unreviewed source excerpt."}]},
            }],
        }],
    }))

    with pytest.raises(EvaluationPrivacyError, match="unlisted public fixture text"):
        load_eval_set(path)


def test_private_evalset_still_rejects_embedded_credentials(tmp_path):
    path = tmp_path / "private.evalset.json"
    path.write_text(json.dumps({
        "eval_set_id": "private",
        "eval_cases": [{
            "evalId": "private-case",
            "conversation": [{
                "userContent": {"parts": [{"text": "Authorization: Bearer secret-token"}]},
            }],
        }],
    }))

    with pytest.raises(EvaluationPrivacyError, match="credential-shaped"):
        load_eval_set(path, public=False)


def test_live_eval_requires_private_output_root(monkeypatch, tmp_path):
    monkeypatch.setenv("HARMONIA_REAL_EVAL", "1")
    monkeypatch.delenv("HARMONIA_MOCK_AI", raising=False)
    monkeypatch.delenv("HARMONIA_EVAL_EVIDENCE_ROOT", raising=False)

    with pytest.raises(RuntimeError, match="HARMONIA_EVAL_EVIDENCE_ROOT"):
        asyncio.run(run_live_eval(
            evalset_path=Path("evals/contracts.evalset.json"),
            output_path=tmp_path / "results.json",
            agent_module="harmonia_agent",
            num_runs=1,
        ))


def test_live_eval_refuses_output_outside_private_root(monkeypatch, tmp_path):
    evidence = tmp_path / "evidence"
    evidence.mkdir()
    monkeypatch.setenv("HARMONIA_REAL_EVAL", "1")
    monkeypatch.delenv("HARMONIA_MOCK_AI", raising=False)
    monkeypatch.setenv("HARMONIA_EVAL_EVIDENCE_ROOT", str(evidence))

    with pytest.raises(RuntimeError, match="private evidence root"):
        asyncio.run(run_live_eval(
            evalset_path=Path("evals/contracts.evalset.json"),
            output_path=tmp_path / "outside.json",
            agent_module="harmonia_agent",
            num_runs=1,
        ))


def test_live_eval_awaits_adk_with_explicit_config(monkeypatch, tmp_path):
    evidence = tmp_path / "evidence"
    evidence.mkdir()
    calls = []

    async def fake_evaluate(**kwargs):
        calls.append(kwargs)

    monkeypatch.setenv("HARMONIA_REAL_EVAL", "1")
    monkeypatch.delenv("HARMONIA_MOCK_AI", raising=False)
    monkeypatch.setenv("HARMONIA_EVAL_EVIDENCE_ROOT", str(evidence))
    monkeypatch.setattr(
        "harmonia_agent.evaluation_runner.AgentEvaluator.evaluate_eval_set",
        fake_evaluate,
    )

    asyncio.run(run_live_eval(
        evalset_path=Path("evals/contracts.evalset.json"),
        output_path=evidence / "results.json",
        agent_module="harmonia_agent",
        num_runs=1,
    ))

    assert calls[0]["num_runs"] == 1
    assert calls[0]["eval_config"].criteria["tool_trajectory_avg_score"] == 1.0
    assert calls[0]["output_file"] == str((evidence / "results.json").resolve())
