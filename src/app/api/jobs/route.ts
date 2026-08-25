import { appendEvent, createJob, listJobs, saveIngestMeta } from "@/lib/firestore";
import { operatorTenantHandler } from "@/lib/auth";
import { publishStage } from "@/lib/pubsub";
import { currentTenant } from "@/lib/tenancy";
import { parseYouTubeUrl } from "@/lib/youtubeUrl";
import { z } from "zod";

const createJobSchema = z.object({
  youtubeUrl: z.string().url().optional(),
  brief: z.string().min(20).max(5000).optional(),
  platforms: z.array(z.enum(["x"])).default(["x"]),
});

async function get(_req: Request) {
  const jobs = await listJobs();
  return Response.json({
    jobs: jobs.map((j) => ({
      id: j.id,
      status: j.status,
      stage: j.stage,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      config: j.config,
      failure: j.failure,
    })),
  });
}

async function post(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = createJobSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid job", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { youtubeUrl, brief, platforms } = parsed.data;
  if (youtubeUrl) {
    const videoId = parseYouTubeUrl(youtubeUrl);
    if (!videoId) {
      return Response.json({ error: "invalid YouTube URL" }, { status: 400 });
    }
    const job = await createJob(
      { youtubeUrl, platforms },
      "ingest",
    );
    await appendEvent(job.id, "queued", `job created for video ${videoId}`, "operator");
    await publishStage(currentTenant(), job.id, "ingest");
    return Response.json({ jobId: job.id }, { status: 201 });
  }

  if (brief) {
    // Concept job: research/ideation from an operator brief skips ingest+transcribe
    // and enters the pipeline at the understand stage.
    const title = brief.length > 60 ? `${brief.slice(0, 57)}...` : brief;
    const job = await createJob({ brief, platforms }, "understand");
    await saveIngestMeta(job.id, {
      videoId: "brief",
      title,
      channel: "operator",
      durationSec: 0,
    });
    await appendEvent(job.id, "understand", "concept job created from operator brief", "operator");
    await publishStage(currentTenant(), job.id, "understand");
    return Response.json({ jobId: job.id }, { status: 201 });
  }

  return Response.json(
    { error: "provide either youtubeUrl or brief" },
    { status: 400 },
  );
}

export const GET = operatorTenantHandler(get);
export const POST = operatorTenantHandler(post);
