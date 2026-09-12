import { z } from "zod";
import { requireWorkspaceAdministrator } from "../authority";
import { awsRepository, partition } from "../dynamo";
import { campaignRoot, readRequired } from "../campaigns/repository";
import { currentTenant, tenantSubjectId } from "../tenancy";
import { strategyDigest } from "../strategyApproval";
import { providerObservationInputSchema, type Collection } from "./contracts";
import { buildObservation, collectionAuthorityDigest, insertObservation, learningKey, persistEvaluationForObservation, persistProviderResult, readObservation, settleCollectionCost, validBinding } from "./repository";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const observationReconciliationSchema = z.object({
  collectionId: digest, token: digest, dispatchDigest: digest, originalReceiptDigest: digest,
  expectedReconciliationDigest: digest.nullable(), requestId: z.string().regex(/^[A-Za-z0-9_.:-]{1,180}$/),
  outcome: z.enum(["confirmed_not_dispatched", "confirmed_dispatched_with_estimated_cost", "confirmed_provider_result", "still_unknown"]),
  evidence: z.object({ kind: z.enum(["operator_attestation", "provider_audit", "provider_response"]), reference: z.string().min(1).max(2000), detail: z.string().min(1).max(10000), checkedAt: z.string().datetime({ offset: true }) }).strict(),
  providerResult: providerObservationInputSchema.nullable(),
}).strict().superRefine((input, ctx) => {
  if ((input.outcome === "confirmed_provider_result") !== Boolean(input.providerResult) || (input.providerResult && !["available", "unavailable"].includes(input.providerResult.outcome))) ctx.addIssue({ code: "custom", message: "only a confirmed provider result may contain received metrics" });
  if (input.providerResult && input.evidence.kind !== "provider_response") ctx.addIssue({ code: "custom", message: "a recovered result requires attributed provider response evidence" });
});
type ReconciliationReceipt = {
  id: string; digest: string; workspaceId: string; brandId: string; inputDigest: string; collectionId: string;
  observationId: string; observationDigest: string; outcome: z.infer<typeof observationReconciliationSchema>["outcome"];
  actor: string; requestId: string; recordedAt: string; originalReceipt: { id: string; digest: string };
  dispatch: NonNullable<Collection["dispatch"]>; dispatchDigest: string; collectionAuthorityDigest: string;
  previousReconciliationDigest: string | null; evidenceRef: { id: string; digest: string };
  actualCostUsd: null; estimatedCostUsd: string | null; costProvenance: "confirmed_no_dispatch" | "configured_upper_bound_estimate" | "unresolved";
};
/** Administrative reconciliation records supplied evidence. It never fetches or retries a provider. */
export async function reconcileObservation(raw: unknown, now = new Date().toISOString()): Promise<ReconciliationReceipt> {
  requireWorkspaceAdministrator(currentTenant());
  const input = observationReconciliationSchema.parse(raw), actor = tenantSubjectId(currentTenant());
  const receipt = await awsRepository().atomic(async tx => {
    const id = `reconciliation-${strategyDigest([actor, input.requestId]).slice(0, 48)}`, key = learningKey("observation_reconciliation_receipts", id), prior = await tx.read(key);
    if (prior.present) {
      const receipt = prior.value as unknown as ReconciliationReceipt, { digest, ...body } = receipt;
      if (strategyDigest(body) !== digest) throw new Error("reconciliation receipt digest mismatch");
      if (receipt.inputDigest !== strategyDigest(input)) throw new Error("reconciliation request identity reused");
      return receipt;
    }
    const collectionKey = learningKey("observation_outbox", input.collectionId), c = await readRequired<Collection>(collectionKey, tx);
    if (c.state !== "reconciliation_required") throw new Error("collection already resolved or not unknown");
    if ((c.reconciliationDigest ?? null) !== input.expectedReconciliationDigest) throw new Error("stale reconciliation revision");
    if (!c.dispatch || c.token !== input.token || c.dispatch.token !== input.token || strategyDigest(c.dispatch) !== input.dispatchDigest) throw new Error("reconciliation dispatch permit mismatch");
    const originalId = `${c.id}:${input.token}`, original = await readRequired<{ outcome: string; token: string; collectionId: string; observationId: string; observationDigest: string; dispatchDigest: string; collectionAuthorityDigest: string }>(learningKey("observation_collection_receipts", originalId), tx);
    if (strategyDigest(original) !== input.originalReceiptDigest || original.outcome !== "unknown" || original.collectionId !== c.id || original.token !== c.token || original.dispatchDigest !== input.dispatchDigest || original.collectionAuthorityDigest !== collectionAuthorityDigest(c)) throw new Error("original unknown receipt binding mismatch");
    const originalObservation = await readObservation(original.observationId, tx);
    if (originalObservation.digest !== original.observationDigest || originalObservation.collectionId !== c.id || originalObservation.availability !== "reconciliation_required") throw new Error("original unknown observation mismatch");
    await validBinding(c, tx);
    if (!c.costAuthorization) throw new Error("missing original cost reservation authority");
    const reservation = await readRequired<{ state: string; jobId: string; collectionId: string; maximumUsd: string }>(learningKey("observation_cost_reservations", c.costAuthorization.reservationId), tx);
    if (reservation.state !== "reserved" || reservation.jobId !== c.jobId || reservation.collectionId !== c.id || reservation.maximumUsd !== c.costAuthorization.maximumUsd) throw new Error("cost reservation changed before reconciliation");
    if (Date.parse(input.evidence.checkedAt) > Date.parse(now) + 5000) throw new Error("reconciliation evidence is in the future");
    const evidenceId = `reconciliation-evidence-${strategyDigest([id, input.evidence]).slice(0, 48)}`;
    const evidenceBody = { workspaceId: c.workspaceId, brandId: c.brandId, collectionId: c.id, collectionAuthorityDigest: collectionAuthorityDigest(c), originalReceiptDigest: input.originalReceiptDigest, dispatchDigest: input.dispatchDigest, actor, ...input.evidence, providerResult: input.providerResult };
    const evidenceDigest = strategyDigest(evidenceBody);
    tx.insert(learningKey("observation_reconciliation_evidence", evidenceId), { ...evidenceBody, digest: evidenceDigest });
    let observation = await readObservation(c.observationId, tx);
    if (input.providerResult) observation = await persistProviderResult(tx, c, input.providerResult, now, [evidenceId]);
    else if (input.outcome !== "still_unknown") {
      observation = buildObservation(c, { availability: "unavailable", value: null, reason: input.outcome === "confirmed_not_dispatched" ? "reconciled_confirmed_not_dispatched" : "reconciled_dispatched_without_metric_result" }, now, { provider: "host", actor, evidenceRefs: [evidenceId] });
      await insertObservation(tx, observation);
    }
    if (input.outcome !== "still_unknown") await settleCollectionCost(tx, c, input.outcome === "confirmed_not_dispatched" ? "released" : "settled", now);
    const body: Omit<ReconciliationReceipt, "digest"> = { id, workspaceId: c.workspaceId, brandId: c.brandId, inputDigest: strategyDigest(input), collectionId: c.id, observationId: observation.id, observationDigest: observation.digest, outcome: input.outcome, actor, requestId: input.requestId, recordedAt: now, originalReceipt: { id: originalId, digest: input.originalReceiptDigest }, dispatch: c.dispatch, dispatchDigest: input.dispatchDigest, collectionAuthorityDigest: collectionAuthorityDigest(c), previousReconciliationDigest: input.expectedReconciliationDigest, evidenceRef: { id: evidenceId, digest: evidenceDigest }, actualCostUsd: null, estimatedCostUsd: input.outcome === "still_unknown" ? null : input.outcome === "confirmed_not_dispatched" ? "0.00" : c.costAuthorization!.maximumUsd, costProvenance: input.outcome === "still_unknown" ? "unresolved" : input.outcome === "confirmed_not_dispatched" ? "confirmed_no_dispatch" : "configured_upper_bound_estimate" };
    const receipt = { ...body, digest: strategyDigest(body) };
    tx.insert(key, receipt); tx.put(collectionKey, { ...c, state: input.outcome === "still_unknown" ? "reconciliation_required" : "completed", observationId: observation.id, reconciliationDigest: receipt.digest });
    return receipt;
  });
  await persistEvaluationForObservation(await readObservation(receipt.observationId));
  return receipt;
}
export async function pendingObservationReconciliations() {
  requireWorkspaceAdministrator(currentTenant());
  const rows = await awsRepository().query(partition(`${campaignRoot()}/observation_outbox`));
  return Promise.all(rows.rows.filter(row => row.value?.state === "reconciliation_required").map(async row => {
    const c = row.value as unknown as Collection;
    const original = await readRequired<Record<string, unknown>>(learningKey("observation_collection_receipts", `${c.id}:${c.token}`));
    return { collectionId: c.id, itemRef: c.itemRef, jobId: c.jobId, measurement: c.measurement, window: c.window, token: c.token, dispatchDigest: strategyDigest(c.dispatch), originalReceiptDigest: strategyDigest(original), expectedReconciliationDigest: c.reconciliationDigest ?? null, reservedMaximumUsd: c.costAuthorization?.maximumUsd, originalReceipt: original };
  }));
}
