import asyncio
from pydantic import BaseModel
from harmonia_agent.coordinator import HarmoniaCoordinator, SpecialistDefinition
from harmonia_agent.team_runtime import LocalStrandsTeamRuntime
from harmonia_agent.runtime_instructions import project_runtime_instructions
from tests.strands_test_model import ScriptedModel

class Output(BaseModel):
    body: str

def test_serialized_team_projects_host_contract_and_repair_into_model_request():
    state = {'_harmonia_output_contract': {'required': ['body']}, '_harmonia_repair': {'path': 'hook'}, '_durable_context_projection': {'private': 'must-not-leak'}}
    instruction = project_runtime_instructions('Static', state)
    assert 'body' in instruction and 'hook' in instruction and 'must-not-leak' not in instruction
    assert project_runtime_instructions('Next', {}) == 'Next'

def test_strands_runner_exposes_contract_without_shared_instruction_mutation(monkeypatch):
    monkeypatch.setenv('HARMONIA_ALLOW_PAID_AWS', 'true')
    model = ScriptedModel([{'body': 'checked'}])
    definition = SpecialistDefinition(name='producer', model=model, instruction='Static', output_schema=Output, output_key='output')
    runtime = LocalStrandsTeamRuntime(HarmoniaCoordinator(name='root', description='', sub_agents=[definition]))
    result = asyncio.run(runtime.invoke(specialist='producer', payload={'_harmonia_output_contract': {'required': ['body']}, '_harmonia_repair': {'path': 'hook'}}, user_id='test', session_key='one'))
    assert result['output'] == {'body': 'checked'}
    assert definition.instruction == 'Static'
    assert 'body' in model.requests[0]['system'] and 'hook' in model.requests[0]['system']
    assert result['_model_request_evidence'][0]['model'] == 'test-model'
