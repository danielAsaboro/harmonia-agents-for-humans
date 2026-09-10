"""Native Strands evaluation with exact public fixture and private evidence boundaries."""
from __future__ import annotations
import argparse
import asyncio
from hashlib import sha256
import json
import os
from pathlib import Path
from pydantic import BaseModel, ConfigDict
from .aws_authority import require_paid_aws
from .agents import build_agent_team, _validate_run_output
from .team_runtime import LocalStrandsTeamRuntime
from .tenant_context import tenant_scope

class EvaluationPrivacyError(ValueError):
    pass

class EvaluationCase(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str
    specialist: str
    input: dict
    expected: dict | None

class EvaluationSet(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str
    cases: list[EvaluationCase]

_PUBLIC_DIGESTS = {
    'route-analyst': '04f80c14aff52259b4a6f9a5eb65ce99fcb95250342687831392f8e9161605e1',
    'copywriter-references': '433d84883943de8ae1b4055251ae326eb3c4d68f4ff1d8bb9e20f1eb03d60a0f',
    'editor-preservation': 'c59b0cc036d23b1b5eda72837ecd4c02667a203def6e89000c8d8c0dedee3b77',
    'liaison-read-only': '436e7a0e1dde14f382f8cf0f8ce49ca678032b23b2a95901c1ba0c21194134c7',
}

def validate_eval_set_privacy(value: EvaluationSet | dict) -> None:
    payload = value.model_dump(mode='json') if isinstance(value, EvaluationSet) else value
    parsed = EvaluationSet.model_validate(payload)
    for case in parsed.cases:
        digest = sha256(json.dumps(case.model_dump(mode='json'), sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        if _PUBLIC_DIGESTS.get(case.id) != digest:
            raise EvaluationPrivacyError('public evaluation contains unapproved fixture content')

def load_eval_set(path: Path, *, public: bool = True) -> EvaluationSet:
    raw = json.loads(path.read_text())
    text = json.dumps(raw).lower()
    if any(marker in text for marker in ('authorization: bearer', 'aws_secret_access_key', 'ghp_', 'aiza')):
        raise EvaluationPrivacyError('credential-shaped material is not allowed')
    if public: validate_eval_set_privacy(raw)
    return EvaluationSet.model_validate(raw)

def _private_output_path(output_path: Path) -> Path:
    configured = os.environ.get('HARMONIA_EVAL_EVIDENCE_ROOT')
    if not configured or not Path(configured).is_absolute():
        raise RuntimeError('HARMONIA_EVAL_EVIDENCE_ROOT must be an absolute private directory')
    output, root = output_path.resolve(), Path(configured).resolve()
    if not output.is_relative_to(root) or output.is_relative_to(Path(__file__).resolve().parents[2]):
        raise RuntimeError('evaluation output must stay in the private evidence root outside the public repository')
    return output

async def run_live_eval(*, evalset_path: Path, output_path: Path, num_runs: int, runtime=None) -> None:
    if os.environ.get('HARMONIA_REAL_EVAL') != '1':
        raise RuntimeError('HARMONIA_REAL_EVAL=1 is required for live evaluation')
    require_paid_aws('live Strands evaluation')
    if not 1 <= num_runs <= 10: raise ValueError('evaluation runs must be 1..10')
    output = _private_output_path(output_path)
    dataset = load_eval_set(evalset_path, public=False)
    team = build_agent_team()
    runtime = runtime or LocalStrandsTeamRuntime(team)
    evidence = []
    for run in range(num_runs):
        for case in dataset.cases:
            specialist = team.select(case.specialist, case.input)
            supplied = specialist.input_schema.model_validate(case.input) if specialist.input_schema else None
            with tenant_scope('public-eval', 'public-eval'):
                state = await runtime.invoke(specialist=case.specialist, payload=case.input,
                    user_id='public-eval:operator', session_key=f'{dataset.id}:{case.id}:{run}')
                try:
                    _validate_run_output(case.specialist, supplied, state)
                    passed, error = True, None
                except Exception as exc:
                    passed, error = False, type(exc).__name__
            evidence.append({'caseId': case.id, 'run': run, 'passed': passed, 'error': error,
                'requestEvidence': state.get('_model_request_evidence', []), 'state': state})
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({'datasetId': dataset.id, 'results': evidence}, indent=2))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evalset', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--num-runs', type=int, default=2)
    args = parser.parse_args()
    asyncio.run(run_live_eval(evalset_path=args.evalset, output_path=args.output, num_runs=args.num_runs))
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
