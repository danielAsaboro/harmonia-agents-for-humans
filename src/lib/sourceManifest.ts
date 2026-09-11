import { createHash,randomUUID } from "node:crypto";
import { awsRepository, recordKey, type DynamoTransaction } from "./dynamo";

import { createJob } from "./repository";
import { sealManifest } from "./sourceRegistry";
import { currentTenant,tenantSubjectId } from "./tenancy";
import type { AnalysisResearchRequest,Job,OutputKind,SourceInput,SourceRecord,StrategyContext } from "./types";
import type { IntakeDraft } from "./intake/contracts";
import { intakeSourceKey } from "./intake/contracts";
import { requireReadyAttachments } from "./chatAttachments";

export interface CreateSourceJobInput {
  operatorBrief?: string;
  librarySnapshotId?: string;
  directSources: SourceInput[];
  desiredOutputs: OutputKind[];
  allowedOutputs?: OutputKind[];
  strategyContext?: StrategyContext;
  analysisResearchRequest?: AnalysisResearchRequest;
  platforms: string[];
  intake?: import("./types").JobConfig["intake"];
  idempotentJobId?: string;
  setup?: (tx: DynamoTransaction, jobId: string) => Promise<void>;
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export function buildSourceRecord(input: SourceInput, id: string, now: string): SourceRecord {
  const tenant = currentTenant();
  const common = {
    id, workspaceId: tenant.workspaceId, brandId: tenant.brandId,
    state: "discovered" as const, rightsAuthorizationId: input.rightsAuthorizationId,
    createdAt: now, updatedAt: now,
  };
  switch (input.kind) {
    case "youtube": return { ...common, provider: "youtube", providerResourceId: input.url, providerVersion: digest(input.url), title: "YouTube video", mimeType: "video/youtube", trust: "public_untrusted" };
    case "web": return { ...common, provider: "web", providerResourceId: input.url, providerVersion: digest(input.url), title: new URL(input.url).hostname, mimeType: "text/html", trust: "public_untrusted" };
    case "upload": return { ...common, provider: "upload", providerResourceId: input.attachmentId, providerVersion: digest(input.attachmentId), title: "Uploaded source", mimeType: "application/octet-stream", trust: "operator_supplied" };
    case "pasted_text": return { ...common, provider: "pasted_text", providerResourceId: digest(input.text), providerVersion: digest(input.text), title: input.title, mimeType: "text/plain", trust: "operator_supplied" };
  }
}

export async function createSourceJob(input: CreateSourceJobInput): Promise<Job> {
  if (input.directSources.length > 10) throw new Error("at most ten direct sources are allowed");
  if (!input.librarySnapshotId && input.directSources.length === 0) throw new Error("at least one source is required");
  const tenant = currentTenant();
  const sourceIds = input.directSources.map(() => randomUUID());
  const manifestId = randomUUID();
  const allowedOutputs = input.allowedOutputs ?? input.desiredOutputs;
  const config = {
    sourceManifestId: manifestId,
    desiredOutputs: input.desiredOutputs,
    allowedOutputs,
    platforms: input.platforms,
    ...(input.operatorBrief ? { operatorBrief: input.operatorBrief } : {}),
    ...(input.strategyContext ? { strategyContext: input.strategyContext } : {}),
    ...(input.analysisResearchRequest ? { analysisResearchRequest: input.analysisResearchRequest } : {}),
    ...(input.intake ? { intake: input.intake } : {}),
  };
  return createJob(config, "collect_sources", async (transaction, jobId, now) => {
    await input.setup?.(transaction, jobId);
    const manifest = sealManifest({
      id: manifestId, jobId, revision: 1,
      ...(input.librarySnapshotId ? { librarySnapshotId: input.librarySnapshotId } : {}),
      directSourceIds: sourceIds, excludedSourceIds: [], exclusionRecords: [], sealedAt: now,
      sealedBySubjectId: tenantSubjectId(tenant),
    });
    transaction.insert(recordKey(`workspaces/${tenant.workspaceId}/jobs/${jobId}/source_manifests/${manifestId}`), manifest);
    input.directSources.forEach((source, index) => {
      const record = buildSourceRecord(source, sourceIds[index], now);
      transaction.insert(recordKey(`workspaces/${tenant.workspaceId}/brands/${tenant.brandId}/sources/${record.id}`), record);
      transaction.insert(recordKey(`workspaces/${tenant.workspaceId}/brands/${tenant.brandId}/source_payloads/${record.id}`), { sourceId: record.id, input: source, createdAt: now });
    });
  }, input.idempotentJobId);
}

/**
 * Knowledge-only intake never starts production.  Local uploads have already
 * passed the normal attachment scan, so retain their exact byte digest and
 * rights binding as ready advisory source authority.  Remote retrieval is not
 * claimed here: web and YouTube sources remain pending a normal source job.
 */
export async function retainKnowledgeOnlyIntake(draft: IntakeDraft): Promise<string[]> {
  if (draft.state !== "retained" || draft.disposition !== "knowledge_only") throw new Error("knowledge-only intake is not retained");
  // Keep remote handles in the retained intake record without claiming that a
  // network fetch succeeded. Only local scanned uploads become ready evidence.
  if (draft.sourceHandles.some(source => source.kind !== "upload")) return [];
  const uploads = draft.sourceHandles.filter((source): source is Extract<typeof source, { kind: "upload" }> => source.kind === "upload");
  const attachments = await requireReadyAttachments(uploads.map(source => source.attachmentId));
  const byId = new Map(attachments.map(attachment => [attachment.id, attachment]));
  const tenant = currentTenant();
  const sourceIds = await awsRepository().atomic(async transaction => {
    const ids: string[] = [];
    for (const source of uploads) {
      const attachment = byId.get(source.attachmentId);
      const rightsAuthorizationId = draft.sourceRights[intakeSourceKey(source)];
      if (!attachment?.sha256 || !rightsAuthorizationId) throw new Error("knowledge attachment authority is incomplete");
      const id = digest(`${draft.id}:${intakeSourceKey(source)}`);
      const key = recordKey(`workspaces/${tenant.workspaceId}/brands/${tenant.brandId}/sources/${id}`);
      const existing = await transaction.read(key);
      if (!existing.present) {
        const discovered = buildSourceRecord({ ...source, rightsAuthorizationId }, id, draft.updatedAt);
        transaction.insert(key, {
          ...discovered,
          state: "ready",
          contentDigest: attachment.sha256,
          extractionReceiptId: `knowledge-intake:${draft.id}:${attachment.id}`,
          updatedAt: new Date().toISOString(),
        });
        transaction.insert(recordKey(`workspaces/${tenant.workspaceId}/brands/${tenant.brandId}/source_payloads/${id}`), {
          sourceId: id,
          input: { ...source, rightsAuthorizationId },
          intakeDraftId: draft.id,
          attachmentDigest: attachment.sha256,
          retainedAt: new Date().toISOString(),
        });
      }
      ids.push(id);
    }
    return ids;
  });
  return sourceIds;
}
