"use client";

import { useEffect, useState } from "react";
import type { PlanningDecision } from "@/lib/planning/dispositions";
import type { EditorialMapping, EditorialRebaseReview } from "@/lib/planning/editorialRebase";
import { Button } from "@/components/dashboard/Button";

export function PlanningProposalDecisionView({ proposal, authorityDigest, busy, onDecide }: { proposal: Record<string, unknown>; authorityDigest: string; busy: boolean; onDecide: (decision: PlanningDecision, mappings: EditorialMapping[]) => void }) {
  const rebases = (proposal.editorialRebases ?? []) as EditorialRebaseReview[];
  const [choices, setChoices] = useState<Record<string, string>>({});
  const mappings = rebases.map(review => ({ itemRef: review.itemRef, briefId: choices[review.itemRef.id] ?? review.defaultBriefId ?? "" }));
  const incomplete = mappings.some(mapping => !mapping.briefId);
  const decisions: Array<[PlanningDecision, string]> = proposal.type === "strategy_rebase" ? [["rebase_to_current_strategy", "Approve rebase to current strategy"], ["cancel", "Cancel queued work"]]
    : proposal.type === "source_replacement" ? [["accept_source_replacement", "Accept replacement sources"], ["reject", "Keep existing sources"], ["cancel", "Cancel queued work"]]
      : ["calendar_change", "measurement_change"].includes(String(proposal.type)) ? [["keep_existing_execution", "Keep existing execution"]] : [];
  return <section className="dash-panel space-y-4">
    <p>Review the exact plan, item revisions, strategy, source selection, and execution authority below. Source acceptance starts retrieval and analysis; effects retain their separate approvals.</p>
    <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(proposal, null, 2)}</pre>
    {proposal.state === "pending_approval" ? rebases.map(review => <label key={review.itemRef.id} className="block">Choose the current brief for {review.itemRef.id}<select className="block" value={choices[review.itemRef.id] ?? review.defaultBriefId ?? ""} disabled={busy} onChange={event => setChoices(current => ({ ...current, [review.itemRef.id]: event.target.value }))}><option value="">Select an exact brief</option>{review.candidates.map(candidate => <option key={candidate.briefId} value={candidate.briefId}>{candidate.briefId}: {candidate.item.objective} — {candidate.item.ctaIntent} — {candidate.item.kpi}</option>)}</select></label>) : null}
    <p className="break-all text-xs">Approval digest: {authorityDigest}</p>
    {proposal.state === "pending_approval" ? <div className="flex flex-wrap gap-2">{decisions.map(([decision, label]) => <Button key={decision} disabled={busy || (decision === "rebase_to_current_strategy" && incomplete)} onClick={() => onDecide(decision, decision === "rebase_to_current_strategy" ? mappings : [])}>{label}</Button>)}</div> : <p>Decision recorded: {String(proposal.decision ?? proposal.state)}.</p>}
  </section>;
}

export default function PlanningProposalReview({ id }: { id: string }) {
  const [review, setReview] = useState<{ proposal: Record<string, unknown>; dispositionAuthorityDigest: string } | null>(null);
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/planning/proposals/${encodeURIComponent(id)}`, { cache: "no-store", signal: controller.signal }).then(async response => {
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Proposal unavailable");
      if (!controller.signal.aborted) setReview(body);
    }).catch(error => { if (!controller.signal.aborted) setError(String(error)); });
    return () => controller.abort();
  }, [id]);
  const decide = async (decision: PlanningDecision, editorialMappings: EditorialMapping[]) => {
    if (!review || busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/planning/proposals/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: crypto.randomUUID(), expectedAuthorityDigest: review.dispositionAuthorityDigest, decision, ...(editorialMappings.length ? { editorialMappings } : {}) }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Decision failed; refresh the current proposal before retrying");
      const current = await fetch(`/api/planning/proposals/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!current.ok) throw new Error("Decision recorded; refresh to read its current state"); setReview(await current.json());
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <>{error ? <p role="alert">{error}</p> : null}{review ? <PlanningProposalDecisionView key={review.dispositionAuthorityDigest} proposal={review.proposal} authorityDigest={review.dispositionAuthorityDigest} busy={busy} onDecide={(decision, mappings) => void decide(decision, mappings)} /> : <p>Loading exact proposal…</p>}</>;
}
