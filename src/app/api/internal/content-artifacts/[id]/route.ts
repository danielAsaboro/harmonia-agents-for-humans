import { contentArtifactSchema } from "@/lib/contentArtifacts/contracts";
import { internalTenantHandler } from "@/lib/internalAuth";
import { getJob } from "@/lib/repository";
import { currentTenant } from "@/lib/tenancy";
import { awsRepository,recordKey } from "../../../../../lib/dynamo";

async function get(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId") ?? "";
  const digest = url.searchParams.get("digest") ?? "";
  if (!jobId || !/^[0-9a-f]{64}$/.test(digest)) {
    return Response.json({ error: "jobId and canonical artifact digest are required" }, { status: 400 });
  }
  const job = await getJob(jobId);
  const summary = job.contentArtifacts?.find(
    (artifact) => artifact.id === id && artifact.contentDigest === digest,
  );
  if (!summary) return Response.json({ error: "content artifact not found" }, { status: 404 });
  const tenant = currentTenant();
  const revision = await awsRepository().read(recordKey(`workspaces/${tenant.workspaceId}/jobs/${jobId}/content_artifacts/${id}/revisions/${summary.revision}`));
  if (!revision.present) return Response.json({ error: "content artifact revision is missing" }, { status: 409 });
  const artifact = contentArtifactSchema.parse(revision.value);
  if (artifact.contentDigest !== digest || artifact.jobId !== jobId) {
    return Response.json({ error: "content artifact revision identity mismatch" }, { status: 409 });
  }
  return Response.json({ artifact });
}

export const GET = internalTenantHandler(get);
