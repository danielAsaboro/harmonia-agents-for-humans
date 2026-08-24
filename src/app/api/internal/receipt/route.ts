import { receiptSubmissionSchema } from "@/lib/contracts";
import {
  appendEvent,
  findReceiptByIdempotencyKey,
  getJob,
  markActionExecuted,
  setStage,
  writeReceipt,
  writeReplayObservation,
} from "@/lib/firestore";
import { internalRoute } from "@/lib/internalHandler";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";
import { publishStage } from "@/lib/pubsub";
import { currentTenant } from "@/lib/tenancy";
import { newId } from "@/lib/idempotency";

export async function POST(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  return internalRoute(req, receiptSubmissionSchema, async (body) => {
    const job = await getJob(body.jobId);
    if (job.stage !== "publish") {
      return Response.json(
        { error: `job stage is '${job.stage}', receipts accepted at 'publish'` },
        { status: 409 },
      );
    }
    // Redelivery safety: a receipt with this idempotency key already exists,
    // so suppress the duplicate write but still reconcile action state (the
    // original run may have crashed between the external effect and the
    // receipt write).
    const duplicate = await findReceiptByIdempotencyKey(
      body.jobId,
      body.idempotencyKey,
    );
    const action = job.actions.find((a) => a.id === body.actionId);
    if (duplicate) {
      await writeReplayObservation({
        id: newId(),
        jobId: body.jobId,
        actionId: body.actionId,
        operationId: `${body.operationId}:replay`,
        traceId: body.traceId,
        receiptId: duplicate.id,
        outcome: "already_applied",
        attemptedAt: new Date().toISOString(),
      });
      if (action && action.state === "planned") {
        await markActionExecuted(
          body.jobId,
          body.actionId,
          body.outcome === "failed" ? "failed" : "executed",
        );
        await appendEvent(
          body.jobId,
          "publish",
          `duplicate receipt suppressed for '${action.title}' (state reconciled)`,
          "system",
          { operationId: `${body.operationId}:reconcile`, traceId: body.traceId },
        );
      }
      return Response.json({ ok: true, duplicateSuppressed: true });
    }
    await writeReceipt({
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
    });
    if (action) {
      await markActionExecuted(
        body.jobId,
        body.actionId,
        body.outcome === "failed" ? "failed" : "executed",
      );
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
    if (outstanding.length === 0) {
      await setStage(body.jobId, "verify");
      const pubsubMessageId = await publishStage(currentTenant(), body.jobId, "verify");
      await appendEvent(
        body.jobId,
        "publish",
        "all approved effects completed; verification dispatched",
        "system",
        { operationId: `${body.operationId}:verify`, traceId: body.traceId, pubsubMessageId },
      );
    }
    return Response.json({ ok: true });
  });
}
