"""Native Pydantic schema retains strict contracts across Strands model requests."""
from harmonia_agent.agents import build_agent_team
from pydantic import BaseModel

def test_every_native_specialist_exposes_a_pydantic_output_contract():
    for specialist in build_agent_team().sub_agents:
        assert issubclass(specialist.output_schema, BaseModel)
        schema = specialist.output_schema.model_json_schema()
        assert schema['type'] == 'object'
        assert schema.get('properties')

def test_semantic_analysis_never_asks_model_to_forge_host_identifiers():
    schema = build_agent_team().find_sub_agent('nimi_analyst').output_schema.model_json_schema()
    assert 'sourceDigest' not in schema['properties']
    for name in ('SemanticMoment','SemanticAngle'):
        assert 'id' not in schema['$defs'][name]['properties']
