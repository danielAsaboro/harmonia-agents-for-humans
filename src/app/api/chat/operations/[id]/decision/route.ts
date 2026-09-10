import { z } from "zod";
import { operatorTenantHandler } from "@/lib/auth";
import { claimPendingOperationDecision, decidePendingOperation, failPendingOperationDecision, finalizePendingOperationDecision, getPendingOperation } from "@/lib/pendingOperations";
import { resolveDecision } from "@/lib/decisions";
import { decideStrategy } from "@/lib/repository";
import { dispatchStageOutboxRecord } from "@/lib/stageOutboxDispatcher";
import { approveProductionPlan, getProductionPlan } from "@/lib/productionPlanStore";
import { readStrategyProposal } from "@/lib/strategy/repository";

const decisionSchema = z.object({ decision: z.enum(["approved", "rejected"]), feedback: z.string().trim().min(1).max(2000).optional() }).strict();

async function post(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = decisionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid operation decision" }, { status: 400 });
  try {
    const pending = await getPendingOperation(id);
    if (!pending) throw new Error("operation not found");
    if (pending.handler === "decide_strategy") {
      const operation = await claimPendingOperationDecision(id, parsed.data.decision, parsed.data.feedback);
      let outcome;
      try {
        const { jobId, proposalId, payloadDigest, expectedActiveRevision } = operation.arguments;
        if (typeof jobId !== "string" || typeof proposalId !== "string" || typeof payloadDigest !== "string" || typeof expectedActiveRevision !== "number") throw new Error("operation is not strategy-bound");
        const proposal = await readStrategyProposal(proposalId);
        if (proposal.jobId !== jobId || proposal.digest !== payloadDigest || proposal.expectedActiveRevision !== expectedActiveRevision) throw new Error("operation strategy proposal mismatch");
        if (proposal.approval) {
          if (proposal.approval.decision !== parsed.data.decision || proposal.approval.actorSubjectId !== operation.decidedByUserId || (proposal.approval.feedback ?? "") !== (operation.decisionFeedback ?? "")) throw new Error("operation strategy decision mismatch");
          outcome = { approval: proposal.approval, strategyRef: proposal.strategyRef, replayed: true };
        } else {
          outcome = await decideStrategy(jobId, { decision: parsed.data.decision, feedback: operation.decisionFeedback, payloadDigest, expectedActiveRevision });
          if (outcome.outboxId) { try { await dispatchStageOutboxRecord(outcome.outboxId); } catch { /* durable dispatcher retries */ } }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // These failures are known pre-commit rejections. Unknown transaction/transport
        // outcomes retain the exact processing intent for lease-based reconciliation.
        if (/^(stale active strategy revision|strategy (?:payload changed|expected active revision mismatch|approval expired|rejection feedback required)|operation (?:is not strategy-bound|strategy proposal mismatch|strategy decision mismatch))$/.test(message)) {
          await failPendingOperationDecision(id, message);
        }
        throw error;
      }
      const finalized = await finalizePendingOperationDecision(id, parsed.data.decision);
      return Response.json({ operation: finalized, outcome });
    }
    if (pending.handler === "decide_production_plan") {
      const operation = await claimPendingOperationDecision(id, parsed.data.decision);
      const { actionId: planId, payloadDigest } = operation.arguments;
      if (typeof planId !== "string" || typeof payloadDigest !== "string") {
        await failPendingOperationDecision(id, "operation is not production-plan-bound");
        throw new Error("operation is not production-plan-bound");
      }
      if (parsed.data.decision !== "approved") {
        await failPendingOperationDecision(id, "production rejection requires feedback through the production plan decision control");
        throw new Error("production rejection requires feedback through the production plan decision control");
      }
      let outcome: unknown;
      try {
        const current = await getProductionPlan(planId);
        outcome = current?.state === "approved" && current.currentPlanDigest === payloadDigest
          ? { reconciled: true, planId, planDigest: payloadDigest }
          : await approveProductionPlan(planId, {
            planDigest: payloadDigest,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          });
      } catch (error) {
        await failPendingOperationDecision(id, error instanceof Error ? error.message : String(error));
        throw error;
      }
      // Finalization is deliberately outside the mandate try/catch. If this
      // write is interrupted after approval, the processing lease expires and
      // redelivery reconciles the matching approved digest instead of falsely
      // recording a failed confirmation.
      const finalized = await finalizePendingOperationDecision(id, parsed.data.decision);
      return Response.json({ operation: finalized, outcome });
    }
    const operation = await decidePendingOperation(id, parsed.data.decision);
    if (operation.handler !== "decide_job_action") return Response.json({ operation });
    const { jobId, actionId, payloadDigest } = operation.arguments;
    if (typeof jobId !== "string" || typeof actionId !== "string" || typeof payloadDigest !== "string") {
      throw new Error("operation is not payload-bound");
    }
    const outcome = await resolveDecision(jobId, actionId, parsed.data.decision, payloadDigest);
    return Response.json({ operation, outcome });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("not found") ? 404 : message.includes("expired") || message.includes("already") ? 409 : 400;
    return Response.json({ error: message }, { status });
  }
}

export const POST = operatorTenantHandler(post);
