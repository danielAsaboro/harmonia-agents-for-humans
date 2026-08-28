import { operatorTenantHandler } from "@/lib/auth";
import { createJobInputSchema } from "@/lib/contracts";
import { appendEvent, listJobs } from "@/lib/firestore";
import { createSourceJob } from "@/lib/sourceManifest";
import { queueStageTrigger } from "@/lib/stageTrigger";

async function get(_req: Request) {
  const jobs = await listJobs();
  return Response.json({ jobs: jobs.map(({ id, status, stage, createdAt, updatedAt, config, failure }) => ({ id, status, stage, createdAt, updatedAt, config, failure })) });
}

async function post(req: Request) {
  const parsed = createJobInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid job", detail: parsed.error.flatten() }, { status: 400 });
  try {
    const job = await createSourceJob(parsed.data);
    await appendEvent(job.id, "collect_sources", `source manifest ${job.config.sourceManifestId} sealed`, "operator");
    await queueStageTrigger(job.id, "collect_sources");
    return Response.json({ jobId: job.id, sourceManifestId: job.config.sourceManifestId }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "job creation failed" }, { status: 400 });
  }
}

export const GET = operatorTenantHandler(get);
export const POST = operatorTenantHandler(post);
