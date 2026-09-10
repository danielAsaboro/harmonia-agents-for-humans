import { operatorTenantHandler } from "@/lib/auth";
import { outputRevisionSchema,planOutputRevision } from "@/lib/outputRevision";
import { db } from "@/lib/repository";
import { assertResourceWorkspace,currentTenant,tenantSubjectId } from "@/lib/tenancy";
import { partition,recordKey } from "../../../../../lib/dynamo";

async function post(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = outputRevisionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid output correction" }, { status: 400 });
  const { id } = await params;
  const scope = currentTenant();
  const ref = recordKey(`workspaces/${scope.workspaceId}/jobs/${id}`);
  try {
    const result = await db().atomic(async (tx) => {
      const snapshot = await tx.read(ref);
      if (!snapshot.present) throw new Error("job not found");
      const job = snapshot.value!;
      assertResourceWorkspace(scope, job as { workspaceId: string; brandId?: string });
      const revision = planOutputRevision(job as Parameters<typeof planOutputRevision>[0], parsed.data.expectedControlEpoch, parsed.data.desiredOutputs);
      const now = new Date().toISOString();
      tx.patch(ref, { ...revision, updatedAt: now });
      tx.insert(recordKey(partition(ref.path + "/" + "output_revisions").partition + "/" + String(revision.controlEpoch)), {
        before: job.config, after: revision.config, controlEpoch: revision.controlEpoch,
        actor: tenantSubjectId(scope), createdAt: now,
      });
      return revision;
    });
    return Response.json({ ok: true, controlEpoch: result.controlEpoch });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "output correction failed" }, { status: 409 });
  }
}

export const POST = operatorTenantHandler(post);
