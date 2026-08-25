import { receiptSubmissionSchema } from "@/lib/contracts";
import {
  appendEvent,
  finalizeEffectReceipt,
  getJob,
  setStage,
} from "@/lib/firestore";
import { internalRoute } from "@/lib/internalHandler";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";
import { publishStage } from "@/lib/pubsub";
import { currentTenant } from "@/lib/tenancy";
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
