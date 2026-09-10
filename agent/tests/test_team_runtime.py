"""Offline tests of native AgentCore requests and real Strands request construction."""
import asyncio
from copy import deepcopy
import io
import json
from types import SimpleNamespace
import pytest
from pydantic import BaseModel, ConfigDict
from strands import tool
from strands.hooks import BeforeToolCallEvent
from harmonia_agent.coordinator import HarmoniaCoordinator, SpecialistDefinition, authorized_specialist_name
from harmonia_agent.team_runtime import AgentCoreProviderError, AgentCoreProtocolError, AgentCoreTeamRuntime, LocalStrandsTeamRuntime, AuthorityHooks, _specialist_prompt_payload
from harmonia_agent.tenant_context import tenant_scope
from tests.strands_test_model import ScriptedModel

ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/harmonia-test'

class Output(BaseModel):
    model_config = ConfigDict(extra='forbid')
    body: str

class Remote:
    def __init__(self, response=None, error=None):
        self.calls=[]; self.response=response or {'state': {'output': {'body':'checked'}}}; self.error=error
    def invoke_agent_runtime(self, **kwargs):
        self.calls.append(kwargs)
        if self.error: raise self.error
        return {'response': io.BytesIO(json.dumps(self.response).encode())}

@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setenv('HARMONIA_ALLOW_PAID_AWS','true')

def definition(model, **kwargs):
    return SpecialistDefinition(name='producer', model=model, instruction='Static skill', output_schema=Output, output_key='output', **kwargs)

def invoke_remote(remote, **kwargs):
    with tenant_scope('workspace','brand'):
        return asyncio.run(AgentCoreTeamRuntime(runtime_arn=ARN,client=remote).invoke(specialist='producer',payload=kwargs.get('payload',{}),user_id='workspace:user',session_key='operation-1'))

def test_local_specialist_prompt_excludes_runtime_only_projection():
    assert _specialist_prompt_payload({'title':'Demo','_private':{'secret':'none'}}) == {'title':'Demo'}

@pytest.mark.parametrize('requested,research_request,expected',[
    ('nimi_analyst',None,'nimi_analyst'),('nimi_analyst',{'mode':'public_web'},'nimi_research_analyst'),
    ('ryan_strategist',None,'ryan_strategist'),('ryan_strategist',{'id':'r'},'ryan_research_strategist'),
])
def test_specialist_selection_is_host_bound(requested,research_request,expected):
    assert authorized_specialist_name(requested,{'researchRequest':research_request}) == expected

def test_runtime_paid_gate_precedes_any_provider_call(monkeypatch):
    monkeypatch.setenv('HARMONIA_ALLOW_PAID_AWS','false')
    remote=Remote()
    with pytest.raises(PermissionError): invoke_remote(remote)
    assert remote.calls == []

def test_native_agentcore_request_binds_tenant_and_deterministic_session(enabled):
    remote=Remote(); result=invoke_remote(remote,payload={'source':'proof'})
    assert result['output']['body']=='checked'
    request=remote.calls[0]
    assert request['agentRuntimeArn']==ARN and len(request['runtimeSessionId'])==64
    envelope=json.loads(request['payload'])
    assert envelope['workspaceId']=='workspace' and envelope['brandId']=='brand'
    invoke_remote(remote,payload={'source':'proof'})
    assert remote.calls[0]['runtimeSessionId']==remote.calls[1]['runtimeSessionId']

def test_unknown_managed_outcome_is_not_blindly_replayed(enabled):
    remote=Remote(error=TimeoutError('response lost'))
    with pytest.raises(AgentCoreProviderError,match='unresolved'): invoke_remote(remote)
    assert len(remote.calls)==1

def test_runtime_rejects_response_without_state(enabled):
    with pytest.raises(AgentCoreProtocolError): invoke_remote(Remote(response={'text':'looks successful'}))

def test_runtime_requires_agentcore_arn():
    with pytest.raises(ValueError): AgentCoreTeamRuntime(runtime_arn='projects/old/reasoningEngines/old')

def test_strands_local_invokes_real_native_structured_output_loop(enabled):
    model=ScriptedModel([{'body':'first'},{'body':'second'}])
    spec=definition(model); runtime=LocalStrandsTeamRuntime(HarmoniaCoordinator('root','',[spec]))
    payload={'_harmonia_repair':{'path':'body'},'_private':'not visible'}; original=deepcopy(payload)
    first=asyncio.run(runtime.invoke(specialist='producer',payload=payload,user_id='u',session_key='1'))
    second=asyncio.run(runtime.invoke(specialist='producer',payload={},user_id='u',session_key='2'))
    assert first['output']=={'body':'first'} and second['output']=={'body':'second'}
    assert payload==original and spec.instruction=='Static skill'
    assert 'ACTIVE COURSE CORRECTION' in model.requests[0]['system']
    assert 'ACTIVE COURSE CORRECTION' not in model.requests[1]['system']
    assert 'not visible' not in str(model.requests)
    assert len(first['_model_request_evidence'])==1

def test_invalid_native_schema_returns_exact_object_for_host_bounded_repair(enabled):
    model=ScriptedModel([{'wrong':'field'}])
    spec=definition(model); runtime=LocalStrandsTeamRuntime(HarmoniaCoordinator('root','',[spec]))
    state=asyncio.run(runtime.invoke(specialist='producer',payload={},user_id='u',session_key='1'))
    assert state['output']=={'wrong':'field'}
    assert len(model.requests)==1

@tool(name='nimi_gateway_search')
def search(request: dict) -> dict:
    """Offline test capability, never a provider integration."""
    return {'ok':True}

def test_research_guard_reserves_before_second_parallel_dispatch():
    request={'id':'r','question':'exact question','mode':'public_web'}
    hooks=AuthorityHooks(definition('model',tools=[search]),{'researchRequest':request})
    event=BeforeToolCallEvent(agent=SimpleNamespace(),selected_tool=search,tool_use={'name':'nimi_gateway_search','input':{'request':request},'toolUseId':'1'},invocation_state={})
    hooks.before_tool(event)
    with pytest.raises(PermissionError,match='consumed'): hooks.before_tool(event)

def test_research_guard_rejects_changed_request_before_dispatch():
    hooks=AuthorityHooks(definition('model',tools=[search]),{'researchRequest':{'id':'r','question':'trusted'}})
    event=BeforeToolCallEvent(agent=SimpleNamespace(),selected_tool=search,tool_use={'name':'nimi_gateway_search','input':{'request':{'id':'r','question':'changed'}},'toolUseId':'1'},invocation_state={})
    with pytest.raises(PermissionError,match='exact'): hooks.before_tool(event)
    assert not hooks.research_dispatched

def test_unavailable_tool_never_receives_authority():
    hooks=AuthorityHooks(definition('model'),{})
    event=BeforeToolCallEvent(agent=SimpleNamespace(),selected_tool=None,tool_use={'name':'publish','input':{},'toolUseId':'1'},invocation_state={})
    with pytest.raises(PermissionError): hooks.before_tool(event)
    assert event.cancel_tool


def test_contextual_liaison_projects_record_without_tools(enabled):
    from harmonia_agent.agents import build_agent_team, RoleModelInstances
    from harmonia_agent.agent_models import LiaisonInput
    model = ScriptedModel([{"answer": "The stored job is waiting for approval."}])
    team = build_agent_team(models=RoleModelInstances(**{role: model for role in ("coordinator", "strategist", "analyst", "copywriter", "editor", "planner", "presenter", "liaison")}))
    payload = LiaisonInput(question="What is next?", contextRecord={"status": "approval_required"}).model_dump(mode="json")
    selected = team.select("nova_liaison", payload)
    assert selected.name == "nova_context_answer" and selected.tools == []
    with tenant_scope("workspace", "brand"):
        result = asyncio.run(LocalStrandsTeamRuntime(team).invoke(specialist="nova_liaison", payload=payload,
            user_id="workspace:user", session_key="context-operation"))
    assert result["context_record_answer"]["answer"].startswith("The stored job")
    assert result["_model_request_evidence"][0]["tools"] == []
    assert "approval_required" in json.dumps(model.requests)


def test_context_record_bound_rejects_oversize():
    from harmonia_agent.ask_api import OperatorQuestion
    with pytest.raises(ValueError, match="60000"):
        OperatorQuestion(question="Explain", contextRecord={"body": "x" * 60001})


def test_liaison_reserves_before_parallel_dispatch():
    @tool
    def get_job_status(job_id: str) -> str:
        """Read status. Args: job_id: job identifier."""
        return "status"
    @tool
    def get_operator_feed() -> str:
        """Read operator feed."""
        return "feed"
    spec = SpecialistDefinition(name="nova_liaison", model="test", instruction="test", output_schema=Output,
        output_key="output", tools=[get_job_status, get_operator_feed])
    hook = AuthorityHooks(spec, {})
    first = SimpleNamespace(tool_use={"name": "get_job_status", "input": {"job_id": "one"}, "toolUseId": "first"})
    hook.before_tool(first)
    with pytest.raises(PermissionError):
        hook.before_tool(SimpleNamespace(tool_use={"name": "get_operator_feed", "input": {}, "toolUseId": "second"}))
    with pytest.raises(PermissionError):
        hook.before_tool(first)
    hook.after_tool(SimpleNamespace(tool_use=first.tool_use, result={"content": [{"json": {"status": "error", "error": {"retryable": True}}}]}))
    hook.before_tool(SimpleNamespace(tool_use={**first.tool_use, "toolUseId": "retry"}))
    assert hook.liaison_attempts == 2
