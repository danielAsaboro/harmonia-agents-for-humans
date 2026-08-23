import { z } from "zod";
import { appendEvent, getJob, setStage } from "@/lib/firestore";
import { tenantHandler } from "@/lib/auth";
import { publishStage } from "@/lib/pubsub";
import { isKnownStage } from "@/lib/stages";
import { currentTenant } from "@/lib/tenancy";

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
  if (job.status !== "failed" || !job.failure) {
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

  await setStage(id, failedStage);
  await appendEvent(
    id,
    failedStage,
    `operator requested retry from stage '${failedStage}'`,
    "operator",
  );
  await publishStage(currentTenant(), id, failedStage);
  return Response.json({ ok: true, retriedFrom: failedStage });
}

export const POST = tenantHandler(post);
