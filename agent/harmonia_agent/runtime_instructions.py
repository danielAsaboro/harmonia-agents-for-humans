"""Project host contracts into the immutable request-scoped Strands prompt."""
import json

def project_runtime_instructions(instruction: str, state: dict) -> str:
    sections = [instruction]
    for key, label in (
        ("_harmonia_output_contract", "HOST-AUTHORIZED PAYLOAD CONTRACT: follow exactly inside payloadJson; no extra fields"),
        ("_harmonia_repair", "ACTIVE COURSE CORRECTION: regenerate from original trusted input and fix these violations"),
    ):
        if state.get(key):
            sections.append(f"{label}\n{json.dumps(state[key], sort_keys=True)}")
    return "\n\n".join(sections)
