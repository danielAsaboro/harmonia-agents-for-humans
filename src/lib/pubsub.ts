import { PubSub } from "@google-cloud/pubsub";
import { getConfig } from "./config";
import { injectTraceContext } from "./telemetry";
import type { TenantScope } from "./tenancy";
import { validateTenantScope } from "./tenancy";

let client: PubSub | null = null;

function pubsub(): PubSub {
  if (!client) {
    client = new PubSub({ projectId: getConfig().GOOGLE_CLOUD_PROJECT });
  }
  return client;
}

export interface StageMessage {
  workspaceId: string;
  brandId: string;
  jobId: string;
  stage: string;
  attempt: number;
}

export interface BuiltStageMessage {
  data: Buffer;
  attributes: Record<string, string>;
}

export function buildStageMessage(
  scope: TenantScope,
  jobId: string,
  stage: string,
  attempt: number,
): BuiltStageMessage {
  const tenant = validateTenantScope(scope);
  const attributes: Record<string, string> = {
    workspaceId: tenant.workspaceId,
    brandId: tenant.brandId,
    jobId,
    stage,
  };
  injectTraceContext(attributes);
  return {
    data: Buffer.from(JSON.stringify({ ...tenant, jobId, stage, attempt } satisfies StageMessage)),
    attributes,
  };
}

export async function publishStage(
  scope: TenantScope,
  jobId: string,
  stage: string,
  attempt = 0,
): Promise<string> {
  const topic = pubsub().topic(getConfig().PUBSUB_STAGE_TOPIC);
  const messageId = await topic.publishMessage(buildStageMessage(scope, jobId, stage, attempt));
  return messageId;
}
