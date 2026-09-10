"""Bedrock sampling configuration for native Strands requests."""
from .role_models import RoleModelConfig

def generation_config(role: RoleModelConfig) -> dict:
    # Claude supports either temperature or top_p for current model families.
    return {"max_tokens": role.max_output_tokens, "temperature": role.generation.temperature}
