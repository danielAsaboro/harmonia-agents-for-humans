import {
  appendEvent,
  getJob,
  markFailed,
  notifyPermanentFailure,
  setStage,
} from "./firestore";
import { publishStage } from "./pubsub";
import { assertTransition, nextStage } from "./stages";
import type { Stage } from "./types";

/**
 * Single place where a completed stage result advances the pipeline:
 * persist the new stage, append an audit event, publish the next Pub/Sub
 * trigger. Called only after the caller has persisted its stage payload.
 */
export async function advance(
  jobId: string,
  completedStage: Stage,
  note: string,
): Promise<void> {
  const job = await getJob(jobId);
  assertTransition(job.stage, completedStage);
  const next = nextStage(completedStage);
  if (!next) throw new Error(`no successor for stage '${completedStage}'`);
  await setStage(jobId, next);
  await appendEvent(jobId, completedStage, note, "system");
  await publishStage(jobId, next);
}

export async function recordFailure(
  jobId: string,
  stage: Stage,
  error: string,
  permanent: boolean,
): Promise<void> {
  await markFailed(jobId, stage, error, permanent);
  await appendEvent(
    jobId,
    stage,
    `${permanent ? "permanent failure" : "transient failure (will be retried by Pub/Sub redelivery)"}: ${error}`,
    "system",
  );
  if (permanent) {
    await notifyPermanentFailure(jobId, stage, error);
  }
}
