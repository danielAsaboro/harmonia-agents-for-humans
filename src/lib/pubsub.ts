import { PubSub } from "@google-cloud/pubsub";
import { getConfig } from "./config";
import { injectTraceContext } from "./telemetry";

let client: PubSub | null = null;

function pubsub(): PubSub {
  if (!client) {
    client = new PubSub({ projectId: getConfig().GOOGLE_CLOUD_PROJECT });
  }
  return client;
}

export interface StageMessage {
  jobId: string;
  stage: string;
  attempt: number;
}

export interface BuiltStageMessage {
  data: Buffer;
  attributes: Record<string, string>;
}

export function buildStageMessage(
  jobId: string,
  stage: string,
  attempt: number,
): BuiltStageMessage {
  const attributes: Record<string, string> = { jobId, stage };
  injectTraceContext(attributes);
  return {
    data: Buffer.from(JSON.stringify({ jobId, stage, attempt } satisfies StageMessage)),
    attributes,
  };
}

export async function publishStage(
  jobId: string,
  stage: string,
  attempt = 0,
): Promise<string> {
  const topic = pubsub().topic(getConfig().PUBSUB_STAGE_TOPIC);
  const messageId = await topic.publishMessage(buildStageMessage(jobId, stage, attempt));
  return messageId;
}
