"""Provider adapters that preserve strict local structured-output contracts."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel


def _adapt_vertex_schema(value: Any) -> Any:
    if isinstance(value, dict):
        adapted = {
            ("anyOf" if key == "oneOf" else key): _adapt_vertex_schema(item)
            for key, item in value.items()
            if key not in {"minItems", "maxItems", "discriminator"}
        }
        return adapted
    if isinstance(value, list):
        return [_adapt_vertex_schema(item) for item in value]
    return value


def vertex_output_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Adapt a strict model schema to Vertex; local validation stays complete."""
    return _adapt_vertex_schema(model.model_json_schema())
