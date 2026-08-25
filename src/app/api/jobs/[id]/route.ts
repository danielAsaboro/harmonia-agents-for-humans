import { eraseJobData, getJob, listApprovalDecisions, listAssets, listEffectClaims, listEvents, listReceipts, listReplayObservations, listUsageRecords } from "@/lib/firestore";
import { administratorTenantHandler, tenantHandler } from "@/lib/auth";
import { redactEffectClaim } from "@/lib/effectClaims";
import { actionPayloadDigest } from "@/lib/idempotency";
import { planJobDeletion } from "@/lib/lifecycle";
import { currentTenant } from "@/lib/tenancy";
import { z } from "zod";

async function get(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const job = await getJob(id);
  const [events, receipts, assets, decisions, replays, usage, claims] = await Promise.all([
    listEvents(id),
    listReceipts(id),
    listAssets(id),
    listApprovalDecisions(id),
    listReplayObservations(id),
    listUsageRecords(id),
    listEffectClaims(id),
  ]);
  return Response.json({
    job: { ...job, actions: job.actions.map((action) => ({ ...action, payloadDigest: actionPayloadDigest(action) })) },
    events,
    receipts,
    decisions,
    replays,
    usage,
    claims: claims.map(redactEffectClaim),
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
