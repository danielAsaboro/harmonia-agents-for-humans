"""Offline model double that exercises the real Strands request/stream contract."""
from copy import deepcopy
import json
from strands.models import Model

class ScriptedModel(Model):
    def __init__(self, outputs, model_id='test-model'):
        self.outputs = list(outputs)
        self.requests = []
        self.config = {'model_id': model_id}
    def update_config(self, **kwargs): self.config.update(kwargs)
    def get_config(self): return self.config
    async def structured_output(self, *args, **kwargs):
        raise AssertionError('Use the native structured_output_model tool loop')
        yield
    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.requests.append(deepcopy({'messages': messages, 'tools': tool_specs, 'system': system_prompt}))
        output = self.outputs.pop(0)
        name = output.pop('_tool', None) or tool_specs[-1]['name']
        yield {'messageStart': {'role': 'assistant'}}
        yield {'contentBlockStart': {'start': {'toolUse': {'toolUseId': str(len(self.requests)), 'name': name}}}}
        yield {'contentBlockDelta': {'delta': {'toolUse': {'input': json.dumps(output)}}}}
        yield {'contentBlockStop': {}}
        yield {'messageStop': {'stopReason': 'tool_use'}}
        yield {'metadata': {'usage': {'inputTokens': 10, 'outputTokens': 5, 'totalTokens': 15}, 'metrics': {'latencyMs': 1}}}
