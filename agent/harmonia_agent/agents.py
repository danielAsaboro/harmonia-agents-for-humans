"""ADK agent definitions for Harmonia's model-driven judgment steps."""

from __future__ import annotations

import os
from typing import Any, Literal

from google.adk.agents.llm_agent import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from pydantic import BaseModel, Field

from .config import settings
from .mock_ai import mock_ai_enabled, mock_plan_actions


class ActionPlan(BaseModel):
    actions: list[dict[str, Any]] = Field(default_factory=list)


def plan_agent() -> Agent:
    s = settings()
    if s.gemini_api_key:
        os.environ.setdefault("GOOGLE_API_KEY", s.gemini_api_key)
    return Agent(
        model=s.model_id,
        name="harmonia_planner",
        description="Decides which drafted posts become publish actions vs pack-only.",
        instruction=(
            "You receive video analysis and validated drafts. Decide corrective publishing actions:\n"
            '- For each X draft under 280 chars propose {"type":"publish_x_post","text":...}.\n'
            '- Always include one {"type":"export_content_pack"} action.\n'
            "Never propose deleting content or bypassing approval. Output JSON only."
        ),
        output_schema=ActionPlan,
        output_key="plan",
    )


async def run_structured(agent: Agent, prompt: str) -> dict[str, Any]:
    if mock_ai_enabled():
        # Skip the LLM entirely; emit the actions JSON the planner would.
        import json as _json
        import re as _re

        print("[MOCK-AI] run_structured: skipping ADK LLM call, emitting deterministic plan", flush=True)
        m = _re.search(r"Drafts: (\[.*?\])\n", prompt, _re.DOTALL)
        drafts = _json.loads(m.group(1)) if m else []
        return mock_plan_actions(drafts)
    runner = Runner(agent=agent, app_name="harmonia", session_service=InMemorySessionService())
    session = await runner.session_service.create_session(app_name="harmonia", user_id="system")
    final: str | None = None
    async for event in runner.run_async(
        user_id="system", session_id=session.id,
        new_message=types.Content(role="user", parts=[types.Part(text=prompt)]),
    ):
        if event.is_final_response() and event.content and event.content.parts:
            final = "".join(p.text or "" for p in event.content.parts)
    if not final:
        raise RuntimeError("planner produced no response")
    import json as _json
    return _json.loads(final)
