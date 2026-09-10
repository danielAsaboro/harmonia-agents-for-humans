import asyncio
import json
from pathlib import Path
import pytest
from harmonia_agent.evaluation_runner import EvaluationPrivacyError, load_eval_set, validate_eval_set_privacy, run_live_eval, _private_output_path
from harmonia_agent.agents import build_agent_team

DATASET = Path(__file__).parents[1] / 'evals/contracts.evalset.json'

def test_public_evalset_uses_native_typed_specialist_inputs():
    dataset = load_eval_set(DATASET)
    assert dataset.id == 'harmonia-contracts-v2'
    team = build_agent_team()
    for case in dataset.cases:
        definition = team.select(case.specialist, case.input)
        if definition.input_schema: definition.input_schema.model_validate(case.input)

@pytest.mark.parametrize('case_index', range(4))
def test_public_fixture_content_is_allowlisted(case_index):
    data = json.loads(DATASET.read_text())
    data['cases'][case_index]['input']['private_source'] = 'private text'
    with pytest.raises(EvaluationPrivacyError): validate_eval_set_privacy(data)

def test_unknown_public_case_is_rejected():
    data = json.loads(DATASET.read_text())
    data['cases'][0]['id'] = 'unknown'
    with pytest.raises(EvaluationPrivacyError): validate_eval_set_privacy(data)

def test_live_eval_requires_explicit_evaluation_and_paid_flags(monkeypatch, tmp_path):
    monkeypatch.delenv('HARMONIA_REAL_EVAL', raising=False)
    with pytest.raises(RuntimeError, match='HARMONIA_REAL_EVAL'):
        asyncio.run(run_live_eval(evalset_path=DATASET, output_path=tmp_path/'result.json', num_runs=1))
    monkeypatch.setenv('HARMONIA_REAL_EVAL','1')
    monkeypatch.setenv('HARMONIA_ALLOW_PAID_AWS','false')
    with pytest.raises(PermissionError):
        asyncio.run(run_live_eval(evalset_path=DATASET, output_path=tmp_path/'result.json', num_runs=1))

def test_evaluation_output_must_remain_private(monkeypatch, tmp_path):
    monkeypatch.setenv('HARMONIA_EVAL_EVIDENCE_ROOT',str(tmp_path))
    assert _private_output_path(tmp_path/'result.json') == tmp_path/'result.json'
    with pytest.raises(RuntimeError): _private_output_path(DATASET)
