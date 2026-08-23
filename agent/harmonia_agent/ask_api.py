"""Authenticated FastAPI boundary for skill-backed operator questions."""

from __future__ import annotations

import hmac
import re
import uuid

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .agents import AgentProtocolError, ask_with_team
from .config import settings
from .team_runtime import AgentEngineProviderError, AgentEngineProtocolError
from .tenant_context import tenant_scope
from .usage import InvocationContext

router = APIRouter()
_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


class OperatorQuestion(BaseModel):
    model_config = {"extra": "forbid"}

    question: str = Field(min_length=1, max_length=2000)


class OperatorAnswer(BaseModel):
    answer: str


@router.post("/internal/agent/ask", response_model=OperatorAnswer)
async def operator_ask(payload: OperatorQuestion, request: Request) -> OperatorAnswer:
    supplied = request.headers.get("x-harmonia-internal-token", "")
    if not hmac.compare_digest(supplied, settings().internal_api_token):
        raise HTTPException(status_code=401, detail="unauthorized")
    workspace_id = _required_id(request, "x-workspace-id")
    brand_id = _required_id(request, "x-brand-id")
    user_id = _required_id(request, "x-user-id")
    ask_id = uuid.uuid4().hex[:12]
    invocation = InvocationContext(
        job_id=f"ask-{ask_id}",
        workspace_id=workspace_id,
        brand_id=brand_id,
        user_id=user_id,
        stage="operator_ask",
        operation_id=f"ask-{ask_id}",
    )
    try:
        with tenant_scope(workspace_id, brand_id):
            answer = await ask_with_team(
                payload.question, invocation=invocation,
            )
    except (AgentProtocolError, AgentEngineProtocolError) as exc:
        raise HTTPException(status_code=502, detail=f"liaison protocol failed: {exc}") from exc
    except AgentEngineProviderError as exc:
        raise HTTPException(status_code=502, detail=f"Agent Engine unavailable: {exc}") from exc
    return OperatorAnswer(answer=answer)


def _required_id(request: Request, header: str) -> str:
    value = request.headers.get(header, "")
    if not _ID.fullmatch(value):
        raise HTTPException(status_code=400, detail=f"valid {header} header required")
    return value
