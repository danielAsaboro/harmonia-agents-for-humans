"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { WorkspaceContentContext } from "@/lib/workspaceContentContext";
import { DashboardPage } from "@/components/dashboard/DashboardPage";
import { EmptyState, ErrorState, LoadingState } from "@/components/dashboard/SystemState";
import { Button } from "@/components/dashboard/Button";

type State = { status: "loading" | "ready" | "error"; workspace?: WorkspaceContentContext; refreshedAt?: string; error?: string };

export default function OperationWorkspace() {
  const [state, setState] = useState<State>({ status: "loading" });
  const request = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = ++revision.current;
    try {
      const response = await fetch("/api/workspace/operation", { cache: "no-store", signal: controller.signal });
      const body = await response.json().catch(() => null) as { workspace?: WorkspaceContentContext; refreshedAt?: string; error?: string } | null;
      if (!response.ok || !body?.workspace) throw new Error(body?.error ?? `Workspace could not be loaded (${response.status}).`);
      if (current === revision.current) setState({ status: "ready", workspace: body.workspace, refreshedAt: body.refreshedAt });
    } catch (error) {
      if (controller.signal.aborted || current !== revision.current) return;
      setState({ status: "error", error: error instanceof Error ? error.message : "Workspace could not be loaded." });
    }
  }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); request.current?.abort(); };
  }, [load]);

  const operation = state.workspace?.operation;
  return <DashboardPage eyebrow="Current authority" title="Content operation" description="A read-only view of the persisted strategy, planned work, approvals, and measured results.">
    {state.status === "loading" ? <LoadingState title="Loading current operation" message="Reading current durable records." /> : null}
    {state.status === "error" ? <ErrorState title="Operation unavailable" message={state.error ?? "Workspace unavailable."} action={<Button onClick={() => void load()}>Retry</Button>} /> : null}
    {state.status === "ready" && operation ? <div className="space-y-5" aria-live="polite">
      <p className="text-xs text-zinc-500">Refreshed {state.refreshedAt ? new Date(state.refreshedAt).toLocaleString() : "unavailable"}. Presentation does not alter approval or execution authority.</p>
      <section className="dash-panel"><h2>Active strategy</h2>{operation.activeStrategy ? <p>{operation.activeStrategy.thesis}<br /><small>Digest {operation.activeStrategy.digest}</small></p> : <EmptyState title="Strategy unavailable" message="No current approved strategy record is available." />}</section>
      <section className="dash-panel"><h2>Proposed changes</h2>{operation.proposedChanges.length ? <ul>{operation.proposedChanges.map(change => <li key={change.id}>{change.id} · {change.status}</li>)}</ul> : <p>No current proposed changes.</p>}</section>
      <section className="dash-panel"><h2>Campaigns and plans</h2>{operation.campaigns.length ? <ul>{operation.campaigns.map(campaign => <li key={campaign.id}><strong>{campaign.name}</strong> · {campaign.objective}</li>)}</ul> : <p>No current campaigns.</p>}<ul>{operation.plans.map(plan => <li key={`${plan.id}:${plan.revision}`}>Plan {plan.id} v{plan.revision}: {plan.reason}</li>)}</ul></section>
      <section className="dash-panel"><h2>Planned work and calendar</h2>{operation.plannedItems.length ? <ul>{operation.plannedItems.map(item => <li key={item.id} className="mb-3"><strong>{item.name}</strong> · {item.scheduledFor} · {item.channel}<br />{item.campaignLabel} · pinned plan {item.planId} · metric{item.metricIds.length === 1 ? "" : "s"} {item.metricIds.join(", ") || "unavailable"}<br />Evidence: {item.evidenceState} · approval: {item.approvalState} · work: {item.dependencyState}{item.unresolvedDependencies.length ? <><br />Unresolved dependencies: {item.unresolvedDependencies.join(", ")}</> : null}</li>)}</ul> : <p>No current planned work.</p>}<Link href="/dashboard/calendar">Open calendar</Link></section>
      <section className="dash-panel"><h2>Approvals and current work</h2><p>{state.workspace?.pendingApprovalCount ?? 0} pending approval{state.workspace?.pendingApprovalCount === 1 ? "" : "s"}.</p><ul>{state.workspace?.recentJobs.map(job => <li key={job.id}><Link href={`/dashboard?job=${encodeURIComponent(job.id)}`}>{job.title ?? job.id}</Link> · {job.stage} · {job.status}</li>)}</ul></section>
      <section className="dash-panel"><h2>Measured results</h2>{operation.results.length ? <ul>{operation.results.map(result => <li key={result.id}>{result.metric} · {result.availability}{result.checkedAt ? ` · checked ${result.checkedAt}` : " · freshness unavailable"}</li>)}</ul> : <p>Measured results unavailable.</p>}</section>
    </div> : null}
  </DashboardPage>;
}
