"""Provider adapters that preserve strict local structured-output contracts."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel


def _without_vertex_unsupported_cardinality(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _without_vertex_unsupported_cardinality(item)
            for key, item in value.items()
            if key not in {"minItems", "maxItems"}
        }
    if isinstance(value, list):
        return [_without_vertex_unsupported_cardinality(item) for item in value]
    return value


def vertex_output_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Adapt a strict model schema to Vertex; local validation stays complete."""
    return _without_vertex_unsupported_cardinality(model.model_json_schema())
