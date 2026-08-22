import { PubSub } from "@google-cloud/pubsub";
import { getConfig } from "./config";

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

export async function publishStage(
  jobId: string,
  stage: string,
  attempt = 0,
): Promise<string> {
  const topic = pubsub().topic(getConfig().PUBSUB_STAGE_TOPIC);
  const messageId = await topic.publishMessage({
    data: Buffer.from(JSON.stringify({ jobId, stage, attempt } satisfies StageMessage)),
    attributes: { jobId, stage },
  });
  return messageId;
}
