import { receiptSubmissionSchema } from "@/lib/contracts";
import {
  appendEvent,
  findReceiptByIdempotencyKey,
  getJob,
  markActionExecuted,
  setStage,
  writeReceipt,
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
    );

    const refreshed = await getJob(body.jobId);
    const outstanding = refreshed.actions.filter((a) => a.state === "planned");
    if (outstanding.length === 0) {
      await setStage(body.jobId, "verify");
      await publishStage(currentTenant(), body.jobId, "verify");
    }
    return Response.json({ ok: true });
  });
}
