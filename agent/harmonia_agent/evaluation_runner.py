"""Load ADK evalsets safely and run explicitly authorized live evaluations."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from google.adk.evaluation.agent_evaluator import AgentEvaluator
from google.adk.evaluation.eval_config import EvalConfig
from google.adk.evaluation.eval_set import EvalSet


class EvaluationPrivacyError(ValueError):
    """A public evalset appears to contain private or credential material."""


_PRIVATE_MARKERS = (
    "raw transcript:",
    "gs://",
    "youtube.com/watch",
    "youtu.be/",
    "gemini_api_key",
    "google_api_key",
    "authorization: bearer",
)


def _serialized_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True).casefold()


def validate_eval_set_privacy(value: EvalSet | dict[str, Any]) -> None:
    """Reject source material and common credential shapes from public fixtures."""
    payload = value.model_dump(mode="json", by_alias=True) if isinstance(value, EvalSet) else value
    text = _serialized_text(payload)
    marker = next((item for item in _PRIVATE_MARKERS if item in text), None)
    if marker is not None:
        raise EvaluationPrivacyError(f"private source marker is not allowed: {marker}")
    if "aiza" in text:
        raise EvaluationPrivacyError("credential-shaped material is not allowed")


def load_eval_set(path: Path) -> EvalSet:
    """Load an ADK 2.x evalset after checking its raw and parsed representations."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    validate_eval_set_privacy(raw)
    eval_set = EvalSet.model_validate(raw)
    validate_eval_set_privacy(eval_set)
    return eval_set


def run_live_eval(
    *, evalset_path: Path, output_path: Path, agent_module: str, num_runs: int,
) -> None:
    if os.environ.get("HARMONIA_MOCK_AI") == "1":
        raise RuntimeError("refusing real evaluation while HARMONIA_MOCK_AI=1")
    if os.environ.get("HARMONIA_REAL_EVAL") != "1":
        raise RuntimeError("set HARMONIA_REAL_EVAL=1 to authorize a live model evaluation")
    eval_set = load_eval_set(evalset_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    AgentEvaluator.evaluate_eval_set(
        agent_module=agent_module,
        eval_set=eval_set,
        eval_config=EvalConfig(criteria={
            "tool_trajectory_avg_score": 1.0,
            "response_match_score": 0.8,
        }),
        num_runs=num_runs,
        output_file=str(output_path),
        print_detailed_results=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evalset", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--agent-module", default="harmonia_agent")
    parser.add_argument("--num-runs", type=int, default=2)
    args = parser.parse_args()
    try:
        run_live_eval(
            evalset_path=args.evalset,
            output_path=args.output,
            agent_module=args.agent_module,
            num_runs=args.num_runs,
        )
    except (EvaluationPrivacyError, RuntimeError, ValueError) as exc:
        parser.exit(2, f"evaluation refused: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
