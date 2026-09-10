"""Native Strands execution locally and through Amazon Bedrock AgentCore Runtime."""
from __future__ import annotations
import asyncio
from copy import deepcopy
from dataclasses import replace
from hashlib import sha256
import json
import os
from types import SimpleNamespace
from typing import Any, Protocol
from strands import Agent
from strands.models import BedrockModel
from strands.hooks import HookProvider, HookRegistry, BeforeModelCallEvent, BeforeToolCallEvent, AfterToolCallEvent
from .aws_authority import require_paid_aws
from .runtime_instructions import project_runtime_instructions
from .tenant_context import current_tenant

class AgentCoreProtocolError(RuntimeError):
    """Runtime returned no valid typed handoff."""

class AgentCoreProviderError(RuntimeError):
    def __init__(self, message: str, *, status: int | None = None):
        super().__init__(message)
        self.status = status

class RejectedStructuredOutput(Exception):
    """Return exact provider object to the host bounded repair controller."""

class TeamRuntime(Protocol):
    async def invoke(self, *, specialist: str, payload: dict, user_id: str, session_key: str) -> dict: ...

def _specialist_prompt_payload(payload: dict) -> dict:
    return {key: value for key, value in payload.items() if not key.startswith('_')}

class AuthorityHooks(HookProvider):
    """Observe actual requests and reserve one-shot tool authority before dispatch."""
    def __init__(self, definition, state: dict):
        self.definition, self.state = definition, state
        self.allowed = {item.tool_name for item in definition.tools}
        self.research_dispatched = False
        self.liaison_inflight = None
        self.liaison_attempts = 0
        self.liaison_request = None
        self.liaison_retryable = False
        self.calls = 0
        self.max_calls = 3 if definition.tools else 1

    def register_hooks(self, registry: HookRegistry, **kwargs):
        registry.add_callback(BeforeModelCallEvent, self.before_model)
        registry.add_callback(BeforeToolCallEvent, self.before_tool)
        registry.add_callback(AfterToolCallEvent, self.after_tool)

    def before_model(self, event: BeforeModelCallEvent):
        require_paid_aws('Bedrock inference')
        self.calls += 1
        if self.calls > self.max_calls:
            raise AgentCoreProtocolError('specialist exceeded its bounded model turns')
        # Digests describe the actual model-visible native request; private prose is not logged.
        request = {'system': event.agent.system_prompt, 'messages': event.agent.messages,
                   'tools': sorted(event.agent.tool_registry.registry)}
        self.state.setdefault('_model_request_evidence', []).append({
            'requestSha256': sha256(json.dumps(request, sort_keys=True, default=str).encode()).hexdigest(),
            'tools': sorted(self.allowed), 'model': event.agent.model.get_config().get('model_id'),
        })

    def before_tool(self, event: BeforeToolCallEvent):
        name, args = event.tool_use['name'], event.tool_use.get('input', {})
        # The native structured-output tool is cognition, not external authority.
        if name == self.definition.output_schema.__name__:
            return
        if name not in self.allowed:
            event.cancel_tool = 'tool is outside host-selected capability set'
            raise PermissionError(str(event.cancel_tool))
        if 'search' in name and name not in {'search_trend_signals', 'search_verified_publications'}:
            request = args.get('request')
            if isinstance(request, str):
                request = json.loads(request)
            if not self.state.get('researchRequest') or request != self.state['researchRequest']:
                raise PermissionError('research must match the exact host-authorized request')
            if self.research_dispatched:
                raise PermissionError('research authority already consumed')
            self.research_dispatched = True
        if name == 'search_verified_publications':
            from .noni_skills import _research_terms
            if args.get('brief_id') != self.state.get('briefId'):
                raise PermissionError('publication search must bind the exact brief')
            if not (_research_terms(str(args.get('query', ''))) & _research_terms(json.dumps(self.state.get('brief', {})))):
                raise PermissionError('publication search query is outside the approved brief')
            if self.research_dispatched:
                raise PermissionError('publication search authority already consumed')
            self.research_dispatched = True
        if self.definition.name == 'nova_liaison':
            request = (name, json.dumps(args, sort_keys=True))
            if self.liaison_inflight is not None or self.liaison_attempts >= 2 or (
                    self.liaison_attempts and (request != self.liaison_request or not self.liaison_retryable)):
                raise PermissionError('liaison permits one read and one completed transient retry')
            # Synchronous reservation precedes any parallel tool dispatch.
            self.liaison_inflight = event.tool_use.get('toolUseId', name)
            self.liaison_request = request
            self.liaison_attempts += 1
            self.liaison_retryable = False
        callback = self.definition.before_tool_callback
        if callback:
            callback(SimpleNamespace(name=name), args, SimpleNamespace(state=self.state))

    def after_tool(self, event: AfterToolCallEvent):
        name = event.tool_use['name']
        if name == self.definition.output_schema.__name__:
            if event.result.get('status') == 'error':
                self.state[self.definition.output_key] = deepcopy(event.tool_use.get('input', {}))
                raise RejectedStructuredOutput()
            return
        response = event.result
        content = response.get('content') or []
        value = next((item['json'] for item in content if 'json' in item), None)
        if value is None:
            text = next((item['text'] for item in content if 'text' in item), '{}')
            try: value = json.loads(text)
            except ValueError: value = {'status': 'error', 'message': text}
        if self.definition.name == 'nova_liaison' and self.liaison_inflight == event.tool_use.get('toolUseId', name):
            self.liaison_inflight = None
            self.liaison_retryable = isinstance(value, dict) and value.get('status') == 'error' and ((value.get('error') or {}).get('retryable') is True)
        if isinstance(value, dict) and '_providerEvidence' in value:
            self.state['_research_evidence'] = value.pop('_providerEvidence')
        callback = self.definition.after_tool_callback
        if callback:
            callback(SimpleNamespace(name=name), event.tool_use.get('input', {}), SimpleNamespace(state=self.state), value)

class LocalStrandsTeamRuntime:
    def __init__(self, coordinator):
        self.coordinator = coordinator

    async def invoke(self, *, specialist: str, payload: dict, user_id: str, session_key: str) -> dict:
        require_paid_aws('Strands specialist invocation')
        state = deepcopy(payload)
        definition = self.coordinator.select(specialist, state)
        request = state.get('researchRequest')
        if definition.name == 'nimi_research_analyst':
            expected = 'nimi_gateway_search' if request.get('mode') == 'public_web' else 'nimi_agent_search_agent'
            definition = replace(definition, tools=[item for item in definition.tools if item.tool_name == expected])
            if len(definition.tools) != 1:
                raise PermissionError('host-authorized research provider is not configured')
        if definition.input_schema:
            definition.input_schema.model_validate(_specialist_prompt_payload(payload))
        if definition.before_agent_callback:
            definition.before_agent_callback(SimpleNamespace(state=state))
        # A new Agent owns all mutable model messages, hooks and tool reservations.
        model = definition.model
        if isinstance(model, str):
            model = BedrockModel(model_id=model, region_name=os.environ.get('AWS_REGION', 'us-east-1'), **definition.generation)
        hooks = AuthorityHooks(definition, state)
        agent = Agent(model=model, name=definition.name, system_prompt=project_runtime_instructions(definition.instruction, state),
                      tools=definition.tools, hooks=[hooks], callback_handler=None,
                      structured_output_model=definition.output_schema, retry_strategy=None)
        try:
            result = await agent.invoke_async(json.dumps(_specialist_prompt_payload(payload), separators=(',', ':'), ensure_ascii=False))
            if result.structured_output is None:
                raise AgentCoreProtocolError('Strands returned no structured output')
            state[definition.output_key] = result.structured_output.model_dump(mode='json')
            state['_strands_usage'] = result.metrics.accumulated_usage
            return state
        except RejectedStructuredOutput:
            return state
        except (AgentCoreProtocolError, PermissionError):
            raise
        except Exception as exc:
            cause = exc
            while cause is not None:
                if isinstance(cause, RejectedStructuredOutput):
                    return state
                cause = cause.__cause__
            status = getattr(exc, 'response', {}).get('ResponseMetadata', {}).get('HTTPStatusCode')
            raise AgentCoreProviderError(f'Strands specialist failed: {type(exc).__name__}', status=status) from exc

class AgentCoreTeamRuntime:
    def __init__(self, *, runtime_arn: str, client: Any = None):
        if ':bedrock-agentcore:' not in runtime_arn or ':runtime/' not in runtime_arn:
            raise ValueError('AGENTCORE_RUNTIME_ARN must be a full AgentCore runtime ARN')
        self.runtime_arn, self.client = runtime_arn, client

    async def invoke(self, *, specialist: str, payload: dict, user_id: str, session_key: str) -> dict:
        require_paid_aws('AgentCore Runtime invocation')
        import boto3
        tenant = current_tenant()
        client = self.client or boto3.client('bedrock-agentcore', region_name=os.environ.get('AWS_REGION', 'us-east-1'))
        envelope = {'specialist': specialist, 'payload': payload, 'userId': user_id,
                    'sessionKey': session_key, 'workspaceId': tenant.workspace_id, 'brandId': tenant.brand_id}
        session_id = sha256(f'{user_id}|{session_key}'.encode()).hexdigest()
        try:
            response = await asyncio.to_thread(client.invoke_agent_runtime, agentRuntimeArn=self.runtime_arn,
                runtimeSessionId=session_id, contentType='application/json', accept='application/json',
                payload=json.dumps(envelope).encode())
            raw = await asyncio.to_thread(response['response'].read)
            state = json.loads(raw)
            if not isinstance(state, dict) or 'state' not in state:
                raise AgentCoreProtocolError('AgentCore returned no state handoff')
            return state['state']
        except (PermissionError, AgentCoreProtocolError):
            raise
        except Exception as exc:
            status = getattr(exc, 'response', {}).get('ResponseMetadata', {}).get('HTTPStatusCode')
            # Do not automatically replay an unknown managed outcome.
            raise AgentCoreProviderError(f'AgentCore outcome unresolved: {type(exc).__name__}', status=status) from exc
