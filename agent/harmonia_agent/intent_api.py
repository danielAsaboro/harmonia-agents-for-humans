"""Authenticated boundary for Harmonia's context-first intent router."""

from __future__ import annotations

import hmac
import re
import uuid

from fastapi import APIRouter, HTTPException, Request

from .agents import route_intent_with_team
from .config import settings
from .intent_routing import IntentRoute, IntentRoutingInput
from .tenant_context import tenant_scope
from .usage import InvocationContext

router = APIRouter()
_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


@router.post("/internal/agent/route", response_model=IntentRoute)
async def route_operator_intent(payload: IntentRoutingInput, request: Request) -> IntentRoute:
    supplied = request.headers.get("x-harmonia-internal-token", "")
    if not hmac.compare_digest(supplied, settings().internal_api_token):
        raise HTTPException(status_code=401, detail="unauthorized")
    workspace_id = request.headers.get("x-workspace-id", "")
    brand_id = request.headers.get("x-brand-id", "")
    user_id = request.headers.get("x-user-id", "")
    if not all(_ID.fullmatch(value) for value in (workspace_id, brand_id, user_id)):
        raise HTTPException(status_code=400, detail="valid tenant headers required")
    route_id = uuid.uuid4().hex[:12]
    invocation = InvocationContext(
        job_id=f"route-{route_id}", workspace_id=workspace_id, brand_id=brand_id,
        user_id=user_id, stage="intent_route", operation_id=f"route-{route_id}",
    )
    with tenant_scope(workspace_id, brand_id):
        return await route_intent_with_team(payload, invocation=invocation)
