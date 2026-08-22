import { z } from "zod";
import { appendEvent, getJob, setStage } from "@/lib/firestore";
import { isOperatorAuthorized, operatorForbidden } from "@/lib/operatorAuth";
import { publishStage } from "@/lib/pubsub";
import { isKnownStage } from "@/lib/stages";

const retrySchema = z.object({});

/**
 * Re-dispatches a permanently failed job from the stage it failed at.
 * Handlers overwrite their stage's data safely, and executed actions are
 * skipped by state, so retries cannot duplicate external effects.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isOperatorAuthorized(req)) return operatorForbidden();
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
  await publishStage(id, failedStage);
  return Response.json({ ok: true, retriedFrom: failedStage });
}
