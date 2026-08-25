import { receiptSubmissionSchema } from "@/lib/contracts";
import {
  appendEvent,
  finalizeEffectReceipt,
  getJob,
  transitionStageWithOutbox,
} from "@/lib/firestore";
import { internalRoute } from "@/lib/internalHandler";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";
import { dispatchStageOutboxRecord } from "@/lib/stageOutboxDispatcher";
import { newId } from "@/lib/idempotency";
import { finalizeCommandReceipt } from "@/lib/effectCommandStore";

export async function POST(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  return internalRoute(req, receiptSubmissionSchema, async (body) => {
    const job = await getJob(body.jobId);
    if (!body.commandId && job.stage !== "publish") {
      return Response.json(
        { error: `job stage is '${job.stage}', receipts accepted at 'publish'` },
        { status: 409 },
      );
    }
    const action = job.actions.find((a) => a.id === body.actionId);
    const receipt = {
      id: newId(),
      jobId: body.jobId,
      actionId: body.actionId,
      idempotencyKey: body.idempotencyKey,
      actionType: body.actionType,
      performedAt: new Date().toISOString(),
      outcome: body.outcome,
      artifact: body.artifact ?? undefined,
      detail: body.detail,
      operationId: body.operationId,
      traceId: body.traceId,
    };
    const finalized = body.commandId
      ? await finalizeCommandReceipt(body.commandId, receipt, body.claimToken)
      : await finalizeEffectReceipt(receipt, body.claimToken);
    if (finalized.duplicate) {
      return Response.json({ ok: true, duplicateSuppressed: true, receiptId: finalized.receipt.id });
    }
    await appendEvent(
      body.jobId,
      "publish",
      `${body.outcome}: ${action?.title ?? body.actionId}`,
      "agent",
      { operationId: body.operationId, traceId: body.traceId },
    );

    const refreshed = await getJob(body.jobId);
    const outstanding = refreshed.actions.filter((a) => a.state === "planned");
    if (job.stage === "publish" && outstanding.length === 0) {
      const outboxId = await transitionStageWithOutbox(body.jobId, "publish", "verify", "all approved effects completed; verification dispatched");
      try { await dispatchStageOutboxRecord(outboxId); } catch { /* durable tick retries */ }
    }
    return Response.json({ ok: true });
  });
}
