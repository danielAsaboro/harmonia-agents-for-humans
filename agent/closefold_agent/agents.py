"""ADK agent definitions. Each judgment point in the pipeline is an ADK
LlmAgent with a structured output schema; external IO stays in deterministic
tools so the model can never fabricate evidence."""

from __future__ import annotations

import json
import os
from typing import Any, Literal

from google.adk.agents.llm_agent import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from pydantic import BaseModel, Field

from .config import settings


class RubricItemModel(BaseModel):
    id: str = Field(description="stable slug id like 'readme-setup'")
    source: str = Field(description="source page URL the requirement came from")
    requirement: str = Field(description="concise statement of the requirement")
    category: str = Field(
        description="one of: readme-setup, architecture, license, video-demo, cloud-deployment, gemini-agent-stack, submission-logistics"
    )
    evidence_hint: str | None = Field(default=None, description="what fetched artifact would prove it")
    weight: float = 1.0


class RubricOutput(BaseModel):
    items: list[RubricItemModel]


class EvidenceRefModel(BaseModel):
    kind: Literal[
        "github_blob",
        "github_api",
        "http_probe",
        "devpost_page",
        "cloud_run_revision",
        "pubsub_message",
        "firestore_doc",
    ]
    url: str
    digest: str | None = None


class FindingModel(BaseModel):
    rubric_item_id: str
    status: Literal["satisfied", "missing", "partial", "unknown"]
    rationale: str = Field(description="must cite observation targets; no speculation")
    evidence: list[EvidenceRefModel] = Field(
        description="only URLs taken verbatim from the provided observations"
    )


class FindingsOutput(BaseModel):
    findings: list[FindingModel]


class UpsertFilePayload(BaseModel):
    type: Literal["github_upsert_file"]
    path: str
    branch: str = "main"
    content: str
    commitMessage: str


class CreateIssuePayload(BaseModel):
    type: Literal["github_create_issue"]
    title: str
    body: str
    labels: list[str] = []


class ProposedActionModel(BaseModel):
    id: str
    type: Literal["github_upsert_file", "github_create_issue"]
    title: str
    description: str
    rubric_item_ids: list[str] = []
    payload: UpsertFilePayload | CreateIssuePayload


class PlanOutput(BaseModel):
    actions: list[ProposedActionModel]


def _runner(agent: Agent) -> Runner:
    return Runner(
        agent=agent,
        app_name="closefold",
        session_service=InMemorySessionService(),
    )


async def run_structured(agent: Agent, prompt: str) -> dict[str, Any]:
    """Runs one ADK agent turn and returns its parsed structured output."""
    runner = _runner(agent)
    session_service = runner.session_service
    session = await session_service.create_session(app_name="closefold", user_id="system")
    final_text: str | None = None
    async for event in runner.run_async(
        user_id="system",
        session_id=session.id,
        new_message=types.Content(role="user", parts=[types.Part(text=prompt)]),
    ):
        if event.is_final_response() and event.content and event.content.parts:
            final_text = "".join(part.text or "" for part in event.content.parts)
    if not final_text:
        raise RuntimeError(f"agent '{agent.name}' produced no final response")
    return json.loads(final_text)


def normalize_rubric_agent() -> Agent:
    s = settings()
    os.environ.setdefault("GOOGLE_API_KEY", s.gemini_api_key or "")
    return Agent(
        model=s.model_id,
        name="rubric_normalizer",
        description="Converts live Devpost requirement text into a traceable rubric.",
        instruction=(
            "You convert hackathon requirement text into a compliance rubric.\n"
            "Rules:\n"
            "- Produce between 6 and 14 items covering every distinct obligation you find "
            "(deliverables, technologies, documentation, demo, deployment proof, dates/logistics).\n"
            "- Each item id is a short stable slug (lowercase, hyphenated).\n"
            "- Category MUST be one of: readme-setup, architecture, license, video-demo, "
            "cloud-deployment, gemini-agent-stack, submission-logistics.\n"
            "- Copy requirement wording faithfully; do not invent obligations.\n"
            "- evidence_hint names the artifact that would prove compliance."
        ),
        output_schema=RubricOutput,
        output_key="rubric",
    )


def evaluate_findings_agent() -> Agent:
    s = settings()
    os.environ.setdefault("GOOGLE_API_KEY", s.gemini_api_key or "")
    return Agent(
        model=s.model_id,
        name="evidence_evaluator",
        description="Maps collected observations onto rubric items to locate gaps.",
        instruction=(
            "You are auditing project evidence against a rubric.\n"
            "You receive rubric items and raw observations fetched from live sources "
            "(GitHub API responses, file digests, HTTP probes).\n"
            "Rules:\n"
            "- Emit exactly one finding per rubric item.\n"
            "- Base status ONLY on observations: satisfied when cited artifacts clearly prove it, "
            "partial when related but incomplete, missing when nothing relevant was observed, "
            "unknown when observations are inconclusive.\n"
            "- Every evidence URL must be copied verbatim from an observation url field. "
            "Never invent or transform URLs.\n"
            "- rationale must name the concrete artifact (path, URL) behind the verdict."
        ),
        output_schema=FindingsOutput,
        output_key="findings",
    )


def plan_actions_agent() -> Agent:
    s = settings()
    os.environ.setdefault("GOOGLE_API_KEY", s.gemini_api_key or "")
    return Agent(
        model=s.model_id,
        name="action_planner",
        description="Plans safe corrective actions for unresolved evidence gaps.",
        instruction=(
            "You plan corrective actions that close evidence gaps in a GitHub repository "
            "you are authorized to modify.\n"
            "Allowed action types only:\n"
            '- github_upsert_file: create/replace one tracked text file (payload.type="github_upsert_file", '
            'path, branch="main", full content, commitMessage). Prefer paths like docs/closefold-evidence.md '
            "or docs/architecture.md for documentation gaps.\n"
            '- github_create_issue: open a tracking issue (payload.type="github_create_issue", title, body, labels).\n'
            "Rules:\n"
            "- At most 5 actions. Only address findings whose status is not satisfied.\n"
            "- File content must be complete, professional, and directly usable (real markdown documents, "
            "checklists with actual gap statements). Never include placeholders like TODO/TBD.\n"
            "- Set rubric_item_ids to the finding ids each action closes.\n"
            "- Do not propose deleting files, force pushes, credential changes, or submissions on behalf of users.\n"
            "- If no gaps exist, return an empty actions list."
        ),
        output_schema=PlanOutput,
        output_key="plan",
    )
