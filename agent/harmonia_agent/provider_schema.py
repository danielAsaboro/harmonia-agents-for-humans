"""Provider adapters that preserve strict local structured-output contracts."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel


def _adapt_vertex_schema(value: Any, *, definitions: dict[str, Any]) -> Any:
    if isinstance(value, dict):
        reference = value.get("$ref")
        if isinstance(reference, str) and reference.startswith("#/$defs/"):
            name = reference.removeprefix("#/$defs/")
            target = definitions.get(name)
            if not isinstance(target, dict):
                raise ValueError(f"unresolved local schema reference: {reference}")
            return _adapt_vertex_schema(
                {**target, **{key: item for key, item in value.items() if key != "$ref"}},
                definitions=definitions,
            )
        adapted = {
            ("anyOf" if key == "oneOf" else "enum" if key == "const" else key): (
                [item] if key == "const" else _adapt_vertex_schema(
                    item, definitions=definitions,
                )
            )
            for key, item in value.items()
            if key not in {"$defs", "minItems", "maxItems", "discriminator"}
        }
        return adapted
    if isinstance(value, list):
        return [_adapt_vertex_schema(item, definitions=definitions) for item in value]
    return value


def vertex_output_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Adapt a strict model schema to Vertex; local validation stays complete."""
    schema = model.model_json_schema()
    definitions = schema.get("$defs") or {}
    return _adapt_vertex_schema(schema, definitions=definitions)
