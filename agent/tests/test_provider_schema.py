"""Provider-facing structured-output schema compatibility."""

from harmonia_agent.agent_models import SourceAnalysis
from harmonia_agent.provider_schema import vertex_output_schema


def test_vertex_output_schema_removes_only_unsupported_array_cardinality():
    schema = vertex_output_schema(SourceAnalysis)
    encoded = str(schema)

    assert "minItems" not in encoded
    assert "maxItems" not in encoded
    assert schema["properties"]["sourceDigest"]["pattern"] == "^[0-9a-f]{64}$"
    assert schema["properties"]["summary"]["maxLength"] == 2000
    assert schema["additionalProperties"] is False

