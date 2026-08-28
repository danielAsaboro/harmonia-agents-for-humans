import { z } from "zod";
import { appendEvent, getJob, retryFailedJobWithOutbox } from "@/lib/firestore";
import { administratorTenantHandler } from "@/lib/auth";
import { dispatchStageOutboxRecord } from "@/lib/stageOutboxDispatcher";
import { isKnownStage } from "@/lib/stages";

const retrySchema = z.object({});

/**
 * Re-dispatches a permanently failed job from the stage it failed at.
 * Handlers overwrite their stage's data safely, and executed actions are
 * skipped by state, so retries cannot duplicate external effects.
 */
async function post(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  void retrySchema.safeParse(body);

  const job = await getJob(id);
  if (!job.failure || (job.status !== "failed" && !job.failure.retryable)) {
    return Response.json(
      { error: "only failed jobs can be retried", status: job.status },
      { status: 409 },
    );
  }
  const failedStage = job.failure.stage;
  if (!isKnownStage(failedStage) || failedStage === "complete" || failedStage === "failed") {
    return Response.json(
      { error: `stage '${failedStage}' is not retryable` },
      { status: 409 },
    );
  }

  const outboxId = await retryFailedJobWithOutbox(id, failedStage, (job.failure.attempt ?? 0) + 1);
  await appendEvent(
    id,
    failedStage,
    `operator requested retry from stage '${failedStage}'`,
    "operator",
  );
  try { await dispatchStageOutboxRecord(outboxId); } catch { /* durable tick retries */ }
  return Response.json({ ok: true, retriedFrom: failedStage });
}

export const POST = administratorTenantHandler(post);
