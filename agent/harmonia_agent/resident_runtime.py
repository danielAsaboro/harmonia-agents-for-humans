"""Resident cycles backed by sealed observations and immutable host records."""
from __future__ import annotations
import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any

from .config import settings
from .tenant_context import tenant_scope
from .web_client import claim_autonomy_cycle, finalize_autonomy_cycle, get_workspaces, post
from .wakeup_call import assemble_wakeup_call

ENDPOINT = '/api/internal/autonomy/runtime'

async def dream_for_tenant(scheduled_at: str) -> dict[str, Any]:
    claim = await asyncio.to_thread(claim_autonomy_cycle, 'dream_cycle', scheduled_at, 900)
    if claim.get('outcome') != 'execute':
        return {'status': claim.get('outcome', 'uncertain')}
    base = {'cycleId': claim['cycleId'], 'claimToken': claim['claimToken']}
    sealed = await asyncio.to_thread(post, ENDPOINT, {'action':'seal', **base})
    if not sealed.get('observations'):
        await asyncio.to_thread(finalize_autonomy_cycle, {**base,'status':'completed','outcome':'no_new_eligible_evidence'})
        return {'status':'completed','reason':'no_new_eligible_evidence'}
    if sealed.get('state') == 'completed':
        output = sealed['output']
    elif sealed.get('state') == 'dispatched':
        await asyncio.to_thread(finalize_autonomy_cycle, {**base, 'status':'uncertain', 'outcome':'prior synthesis dispatch requires reconciliation'})
        return {'status':'uncertain','reason':'prior synthesis dispatch requires reconciliation'}
    else:
        from .team_runtime import AgentCoreTeamRuntime
        from .autonomy_models import DreamCycleInput
        payload = DreamCycleInput(cycle_id=claim['cycleId'], observations=[
            {'id': o['id'], 'observation_type':o['observationType'], 'facts':o['facts']}
            for o in sealed['observations']
        ])
        runtime = AgentCoreTeamRuntime(runtime_arn=settings().agentcore_runtime_arn)
        reserved = await asyncio.to_thread(post, ENDPOINT, {'action':'reserve', **base})
        if not reserved.get('accepted'):
            await asyncio.to_thread(finalize_autonomy_cycle, {**base,'status':'partially_completed','outcome':str(reserved.get('reason','budget unavailable'))})
            return {'status':'paused','reason':reserved.get('reason')}
        try:
            result = await runtime.invoke(specialist='harmonia_dream_synthesizer', payload=payload.model_dump(mode='json'),
                user_id=f"{sealed['workspaceId']}:resident", session_key=claim['cycleId'])
            output = result['dream_cycle_output']
        except Exception:
            # Reservation and dispatch remain retained; no automatic paid replay.
            await asyncio.to_thread(finalize_autonomy_cycle, {**base,'status':'uncertain','outcome':'synthesis outcome requires reconciliation'})
            raise
    await asyncio.to_thread(post, ENDPOINT, {'action':'persist', **base, 'output':output})
    await asyncio.to_thread(finalize_autonomy_cycle, {**base,'status':'completed','outcome':'verified observations synthesized'})
    return {'status':'completed','cycleId':claim['cycleId']}


def _ids(values: list[Any]) -> list[str]:
    return [v if isinstance(v,str) else str(v.get('id') or v.get('jobId') or v.get('actionId')) for v in values if isinstance(v,str) or isinstance(v,dict) and (v.get('id') or v.get('jobId') or v.get('actionId'))]

async def wakeup_for_tenant(scheduled_at: str) -> dict[str, Any]:
    claim = await asyncio.to_thread(claim_autonomy_cycle, 'wakeup_call', scheduled_at, 300)
    if claim.get('outcome') != 'execute': return {'status':claim.get('outcome','uncertain')}
    base = {'cycleId':claim['cycleId'],'claimToken':claim['claimToken']}
    stored = await asyncio.to_thread(post, ENDPOINT, {'action':'seal_wakeup', **base})
    feed = stored['operations']
    if not stored.get('dream') and not feed.get('failedJobs') and not feed.get('pendingApprovals'):
        await asyncio.to_thread(finalize_autonomy_cycle,{**base,'status':'completed','outcome':'no_actionable_change'})
        return {'status':'completed','reason':'no_actionable_change'}
    operations = {**feed,'failedJobs':_ids(feed.get('failedJobs',[])), 'pendingApprovals':_ids(feed.get('pendingApprovals',[]))}
    briefing = assemble_wakeup_call(cycle_id=claim['cycleId'],dream=stored.get('dream') or {},operations=operations)
    deadline = (datetime.fromisoformat(scheduled_at.replace('Z','+00:00'))+timedelta(days=1)).isoformat()
    items = [{**item,'estimatedCostUsd':0,'deadline':deadline,'risk':'low'} for item in briefing['items']]
    await asyncio.to_thread(post,ENDPOINT,{'action':'wakeup',**base,'briefing':briefing['briefing'],'items':items})
    await asyncio.to_thread(finalize_autonomy_cycle,{**base,'status':'completed','outcome':'persisted morning agenda'})
    return {'status':'completed','cycleId':claim['cycleId'],'itemCount':len(items)}

async def run_resident_cycle(kind: str) -> dict[str,Any]:
    # Match the Africa/Lagos scheduler window, including its UTC date boundary.
    from zoneinfo import ZoneInfo
    local = datetime.now(ZoneInfo('Africa/Lagos'))
    now=local.replace(hour=2 if kind=='dream' else 8,minute=0,second=0,microsecond=0).isoformat()
    handler={'dream':dream_for_tenant,'wakeup':wakeup_for_tenant}[kind]
    results=[]
    for scope in await asyncio.to_thread(get_workspaces):
        with tenant_scope(scope['workspaceId'],scope['brandId']):
            try: result=await handler(now)
            except Exception as exc: result={'status':'failed','errorType':type(exc).__name__}
            results.append({'workspaceId':scope['workspaceId'],**result})
    return {'ok':all(r.get('status')!='failed' for r in results),'workspaces':results}
