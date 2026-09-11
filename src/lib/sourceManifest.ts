import { createHash,randomUUID } from "node:crypto";
import { awsRepository, recordKey, type DynamoTransaction } from "./dynamo";

import { createJob } from "./repository";
import { sealManifest } from "./sourceRegistry";
import { assertResourceWorkspace, currentTenant,tenantSubjectId } from "./tenancy";
import type { AnalysisResearchRequest,Job,JobConfig,OutputKind,SourceInput,SourceRecord,StrategyContext } from "./types";
import type { IntakeDraft } from "./intake/contracts";
import { intakeSourceKey } from "./intake/contracts";
import type { ChatAttachment } from "./chatAttachments";
import { intakeDraftKey } from "./intake/repository";

export interface CreateSourceJobInput {
  operatorBrief?: string;
  originalOperatorBrief?: JobConfig["originalOperatorBrief"];
  instructionContext?: JobConfig["instructionContext"];
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
const canonicalSha256 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

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
    ...(input.originalOperatorBrief ? { originalOperatorBrief: input.originalOperatorBrief } : {}),
    ...(input.instructionContext ? { instructionContext: input.instructionContext } : {}),
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
  const uploads = draft.sourceHandles.filter((source): source is Extract<typeof source, { kind: "upload" }> => source.kind === "upload");
  if (!uploads.length) return [];
  const tenant = currentTenant();
  const sourceIds = await awsRepository().atomic(async transaction => {
    // Retention is its own authority boundary. Read the persisted intake, the
    // scanned attachment, and the attestation in this transaction so a stale
    // draft cannot retain bytes or rights that were replaced or revoked.
    const intakeRow = await transaction.read(intakeDraftKey(draft.id));
    if (!intakeRow.present) throw new Error("knowledge intake draft is missing");
    const currentDraft = intakeRow.value as unknown as IntakeDraft;
    assertResourceWorkspace(tenant, currentDraft);
    if (currentDraft.subjectId !== tenantSubjectId(tenant)
      || currentDraft.state !== "retained"
      || currentDraft.disposition !== "knowledge_only"
      || currentDraft.revision !== draft.revision) {
      throw new Error("knowledge intake draft changed before retention");
    }
    const ids: string[] = [];
    for (const source of uploads) {
      const sourceKey = intakeSourceKey(source);
      const currentSource = currentDraft.sourceHandles.find(candidate => intakeSourceKey(candidate) === sourceKey);
      if (!currentSource || currentSource.kind !== "upload" || currentSource.attachmentId !== source.attachmentId) {
        throw new Error("knowledge intake source changed before retention");
      }
      const attachmentRow = await transaction.read(recordKey(`workspaces/${tenant.workspaceId}/chat_attachments/${source.attachmentId}`));
      if (!attachmentRow.present) throw new Error("knowledge attachment is missing");
      const attachment = attachmentRow.value as unknown as ChatAttachment;
      assertResourceWorkspace(tenant, attachment);
      if (attachment.id !== source.attachmentId
        || attachment.createdByUserId !== currentDraft.subjectId
        || attachment.state !== "ready"
        || !canonicalSha256(attachment.sha256)) {
        throw new Error("knowledge attachment authority is incomplete");
      }
      const rightsAuthorizationId = currentDraft.sourceRights[sourceKey];
      if (!rightsAuthorizationId) throw new Error("source rights required for exact source handle");
      const rightsRow = await transaction.read(recordKey(`workspaces/${tenant.workspaceId}/brands/${tenant.brandId}/source_rights/${rightsAuthorizationId}`));
      if (!rightsRow.present) throw new Error("source rights authorization missing");
      const rights = rightsRow.value as {
        id?: string; workspaceId: string; brandId: string; revokedAt?: string;
        sourceHandleDigest?: string; sourceKind?: string; attestedBySubjectId?: string; authenticationId?: string;
      };
      assertResourceWorkspace(tenant, rights);
      if (rights.revokedAt) throw new Error("source rights authorization revoked");
      if (rights.id !== rightsAuthorizationId
        || rights.sourceHandleDigest !== sourceKey
        || rights.sourceKind !== source.kind
        || rights.attestedBySubjectId !== currentDraft.subjectId
        || rights.attestedBySubjectId !== tenantSubjectId(tenant)
        || rights.authenticationId !== tenant.principal.authenticationId) {
        throw new Error("source rights binding mismatch");
      }
      const id = digest(`${currentDraft.id}:${sourceKey}`);
      const key = recordKey(`workspaces/${tenant.workspaceId}/brands/${tenant.brandId}/sources/${id}`);
      const existing = await transaction.read(key);
      if (!existing.present) {
        const discovered = buildSourceRecord({ ...source, rightsAuthorizationId }, id, currentDraft.updatedAt);
        transaction.insert(key, {
          ...discovered,
          state: "ready",
          contentDigest: attachment.sha256,
          extractionReceiptId: `knowledge-intake:${draft.id}:${attachment.id}`,
          updatedAt: new Date().toISOString(),
        });
        transaction.insert(recordKey(`workspaces/${tenant.workspaceId}/brands/${tenant.brandId}/source_payloads/${id}`), {
          sourceId: id, workspaceId: tenant.workspaceId, brandId: tenant.brandId,
          input: { ...source, rightsAuthorizationId },
          intakeDraftId: currentDraft.id,
          attachmentDigest: attachment.sha256,
          retainedAt: new Date().toISOString(),
        });
      } else {
        const retained = existing.value as unknown as SourceRecord;
        assertResourceWorkspace(tenant, retained);
        const payload = await transaction.read(recordKey(`workspaces/${tenant.workspaceId}/brands/${tenant.brandId}/source_payloads/${id}`));
        const retainedPayload = payload.value as {
          workspaceId?: string; brandId?: string; sourceId?: string; intakeDraftId?: string;
          attachmentDigest?: string; input?: { kind?: string; rightsAuthorizationId?: string; attachmentId?: string };
        } | undefined;
        if (!payload.present
          || retained.id !== id
          || retained.state !== "ready"
          || retained.provider !== "upload"
          || retained.providerResourceId !== source.attachmentId
          || retained.contentDigest !== attachment.sha256
          || retained.rightsAuthorizationId !== rightsAuthorizationId
          || retainedPayload?.workspaceId !== tenant.workspaceId
          || retainedPayload?.brandId !== tenant.brandId
          || retainedPayload?.sourceId !== id
          || retainedPayload?.intakeDraftId !== currentDraft.id
          || retainedPayload?.attachmentDigest !== attachment.sha256
          || retainedPayload?.input?.kind !== "upload"
          || retainedPayload?.input?.rightsAuthorizationId !== rightsAuthorizationId
          || retainedPayload?.input?.attachmentId !== source.attachmentId) {
          throw new Error("retained knowledge source no longer matches intake authority");
        }
      }
      ids.push(id);
    }
    return ids;
  });
  return sourceIds;
}
