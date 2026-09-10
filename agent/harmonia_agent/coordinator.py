"""Host-owned specialist definitions; Strands never chooses workflow authority."""
from dataclasses import dataclass, field
from typing import Any, Callable
from pydantic import BaseModel

@dataclass(frozen=True)
class SpecialistDefinition:
    name: str
    model: Any
    instruction: str
    output_key: str
    output_schema: type[BaseModel]
    description: str = ""
    input_schema: type[BaseModel] | None = None
    generation: dict = field(default_factory=dict)
    tools: list = field(default_factory=list)
    before_agent_callback: Callable | None = None
    before_tool_callback: Callable | None = None
    after_tool_callback: Callable | None = None
    on_tool_error_callback: Callable | None = None

@dataclass(frozen=True)
class HarmoniaCoordinator:
    name: str
    description: str
    sub_agents: list[SpecialistDefinition]

    def find_sub_agent(self, name: str) -> SpecialistDefinition | None:
        return next((item for item in self.sub_agents if item.name == name), None)

    def select(self, requested: str, state: dict) -> SpecialistDefinition:
        name = authorized_specialist_name(requested, state)
        selected = self.find_sub_agent(name)
        if selected is None:
            raise ValueError(f"Unknown host-selected specialist: {requested}")
        return selected


def authorized_specialist_name(requested: str, state: dict) -> str:
    if requested == "nova_liaison" and state.get("contextRecord") is not None:
        return "nova_context_answer"
    if requested == "nimi_analyst" and state.get("researchRequest") is not None:
        return "nimi_research_analyst"
    if requested == "ryan_strategist" and state.get("researchRequest") is not None:
        return "ryan_research_strategist"
    return requested
