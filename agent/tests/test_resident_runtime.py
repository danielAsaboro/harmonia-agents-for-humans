"""Resident worker uses sealed host evidence and never repeats an unknown model call."""
import asyncio
from unittest.mock import Mock
from harmonia_agent import resident_runtime as runtime

CLAIM={"outcome":"execute","cycleId":"cycle","claimToken":"token"}

def test_dispatched_dream_is_reconciliation_only(monkeypatch):
    monkeypatch.setattr(runtime,"claim_autonomy_cycle",lambda *a:CLAIM)
    responses=[];final=[]
    def post(path,payload):
        responses.append(payload["action"])
        return {"state":"dispatched","observations":[{"id":"o"}]}
    monkeypatch.setattr(runtime,"post",post)
    monkeypatch.setattr(runtime,"finalize_autonomy_cycle",final.append)
    result=asyncio.run(runtime.dream_for_tenant("2026-09-10T02:00:00+01:00"))
    assert result["status"]=="uncertain"
    assert responses==["seal"]
    assert final[0]["status"]=="uncertain"

def test_completed_dream_projects_without_new_reservation(monkeypatch):
    monkeypatch.setattr(runtime,"claim_autonomy_cycle",lambda *a:CLAIM)
    calls=[];output={"reflections":[],"hypotheses":[],"experiments":[],"safe_activity_summary":"No change."}
    def post(path,payload):
        calls.append(payload)
        return {"state":"completed","observations":[{"id":"o"}],"output":output} if payload["action"]=="seal" else {"completed":True}
    monkeypatch.setattr(runtime,"post",post);monkeypatch.setattr(runtime,"finalize_autonomy_cycle",lambda p:None)
    assert asyncio.run(runtime.dream_for_tenant("2026-09-10T02:00:00+01:00"))["status"]=="completed"
    assert [p["action"] for p in calls]==["seal","persist"]
    assert calls[1]["output"]==output

def test_wakeup_uses_host_sealed_pending_approvals(monkeypatch):
    monkeypatch.setattr(runtime,"claim_autonomy_cycle",lambda *a:CLAIM)
    calls=[]
    def post(path,payload):
        calls.append(payload)
        return {"dream":None,"operations":{"failedJobs":[],"pendingApprovals":["job-approval"],"budgetAvailable":True,"providerHealth":"unknown"}} if payload["action"]=="seal_wakeup" else {"completed":True}
    monkeypatch.setattr(runtime,"post",post);monkeypatch.setattr(runtime,"finalize_autonomy_cycle",lambda p:None)
    result=asyncio.run(runtime.wakeup_for_tenant("2026-09-10T08:00:00+01:00"))
    assert result["itemCount"]==1
    assert [p["action"] for p in calls]==["seal_wakeup","wakeup"]
    assert calls[1]["items"][0]["evidenceRefs"]==["job-approval"]
    assert calls[1]["items"][0]["authority"]=="request_attention"
