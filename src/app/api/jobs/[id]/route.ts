import { db, eraseJobData, getJob, listApprovalDecisions, listAssets, listEffectClaims, listEvents, listReceipts, listReplayObservations, listUsageRecords } from "@/lib/firestore";
import { administratorTenantHandler, tenantHandler } from "@/lib/auth";
import { redactEffectClaim } from "@/lib/effectClaims";
import { actionPayloadDigest } from "@/lib/idempotency";
import { planJobDeletion } from "@/lib/lifecycle";
import { currentTenant } from "@/lib/tenancy";
import { getArtifact } from "@/lib/storage";
import { normalizedSourceSchema } from "@/lib/contracts";
import { getProductionPlanWorkspaceForJob } from "@/lib/productionPlanStore";
import { z } from "zod";
import { listCommandEffectClaimsForJob } from "@/lib/effectCommandStore";

async function get(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const job = await getJob(id);
  const tenant = currentTenant();
  const manifestSnapshot = await db().doc(`workspaces/${tenant.workspaceId}/jobs/${id}/source_manifests/${job.config.sourceManifestId}`).get();
  const manifest = manifestSnapshot.data() as { directSourceIds?: string[]; librarySnapshotId?: string } | undefined;
  let sourceIds = [...(manifest?.directSourceIds ?? [])];
  if (manifest?.librarySnapshotId) {
    const libraries = await db().collection(`workspaces/${tenant.workspaceId}/brands/${tenant.brandId}/brand_libraries`).get();
    for (const library of libraries.docs) {
      const snapshot = await library.ref.collection("snapshots").doc(manifest.librarySnapshotId).get();
      if (snapshot.exists) {
        sourceIds.push(...((snapshot.get("fileVersions") as Array<{ sourceId: string }> | undefined) ?? []).map((item) => item.sourceId));
        break;
      }
    }
  }
  sourceIds = [...new Set(sourceIds)];
  const sourceRecords = (await Promise.all(sourceIds.map(async (sourceId) => {
    const snapshot = await db().doc(`workspaces/${tenant.workspaceId}/brands/${tenant.brandId}/sources/${sourceId}`).get();
    return snapshot.exists ? snapshot.data() : null;
  }))).filter(Boolean);
  const normalizedSources = (await Promise.all(sourceRecords.map(async (record) => {
    const artifactId = (record as { normalizedArtifactId?: string }).normalizedArtifactId;
    if (!artifactId) return null;
    const bytes = await getArtifact(artifactId);
    if (!bytes) return null;
    const parsed = normalizedSourceSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    return parsed.success ? parsed.data : null;
  }))).filter(Boolean);
  const [events, receipts, assets, decisions, replays, usage, claims, commandClaims, productionPlan] = await Promise.all([
    listEvents(id),
    listReceipts(id),
    listAssets(id),
    listApprovalDecisions(id),
    listReplayObservations(id),
    listUsageRecords(id),
    listEffectClaims(id),
    listCommandEffectClaimsForJob(id),
    getProductionPlanWorkspaceForJob(id),
  ]);
  const allClaims = [...claims, ...commandClaims].filter((claim, index, values) =>
    values.findIndex((candidate) =>
      candidate.operationId === claim.operationId && candidate.idempotencyKey === claim.idempotencyKey,
    ) === index,
  );
  return Response.json({
    job: { ...job, sourceRecords, normalizedSources, productionPlan, actions: job.actions.map((action) => ({ ...action, payloadDigest: actionPayloadDigest(action) })) },
    events,
    receipts,
    decisions,
    replays,
    usage,
    claims: allClaims.map(redactEffectClaim),
    assets: assets.map((a) => ({
      actionId: a.actionId,
      mime: a.mime,
      sizeBytes: a.sizeBytes,
      digest: a.digest,
    })),
  });
}

export const GET = tenantHandler(get);

const DeleteBody = z.object({
  confirmation: z.string().min(1),
  reason: z.string().min(1).max(2000),
}).strict();

async function del(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const parsed = DeleteBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid deletion request" }, { status: 400 });
  try {
    const job = await getJob(id);
    const plan = planJobDeletion({
      job,
      confirmation: parsed.data.confirmation,
      reason: parsed.data.reason,
    });
    await eraseJobData(plan, currentTenant().principal.subjectId);
    return Response.json({ ok: true, jobId: id, contentErased: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "job deletion failed" },
      { status: 409 },
    );
  }
}

export const DELETE = administratorTenantHandler(del);
