import { requireContentOperator } from "./authority";
import { createHash } from "node:crypto";
import type { TenantContext } from "./tenancy";

export const RIGHTS_ATTESTATION_PHRASE = "I confirm I have rights to use this source";

export interface SourceRightsAuthorization {
  version: "source-rights-v1";
  sourceKind: "youtube" | "web" | "upload" | "pasted_text";
  attestedBySubjectId: string;
  authenticationId: string;
  channel: "dashboard" | "telegram";
  attestedAt: string;
  sourceHandleDigest?: string;
}

export function sourceRightsAuthorizationId(authorization: SourceRightsAuthorization): string {
  return `rights_${createHash("sha256").update(JSON.stringify(authorization)).digest("hex").slice(0, 32)}`;
}

export function hasRightsAttestation(message: string): boolean {
  return message.toLocaleLowerCase().includes(RIGHTS_ATTESTATION_PHRASE.toLocaleLowerCase());
}

export function sourceRightsAuthorization(
  context: TenantContext,
  sourceKind: SourceRightsAuthorization["sourceKind"],
  now = new Date().toISOString(),
  sourceHandleDigest?: string,
): SourceRightsAuthorization {
  const actor = requireContentOperator(context);
  return {
    version: "source-rights-v1",
    sourceKind,
    attestedBySubjectId: actor.subjectId,
    authenticationId: actor.authenticationId,
    channel: actor.kind === "telegram_user" ? "telegram" : "dashboard",
    attestedAt: now,
    ...(sourceHandleDigest ? { sourceHandleDigest } : {}),
  };
}

export async function persistSourceRightsAuthorization(authorization: SourceRightsAuthorization): Promise<string> {
  const { awsRepository, recordKey } = await import("./dynamo");
  const { currentTenant } = await import("./tenancy");
  const scope = currentTenant();
  const id = sourceRightsAuthorizationId(authorization);
  const key = recordKey(`workspaces/${scope.workspaceId}/brands/${scope.brandId}/source_rights/${id}`);
  await awsRepository().atomic(async tx => {
    const prior = await tx.read(key);
    if (!prior.present) tx.insert(key, { ...authorization, id, workspaceId: scope.workspaceId, brandId: scope.brandId });
  });
  return id;
}
