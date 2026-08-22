import { createJob, appendEvent, listJobs } from "@/lib/firestore";
import { saveTranscript, saveAnalysis, saveDrafts, saveContentPack } from "@/lib/firestore";
import { isOperatorAuthorized, operatorForbidden } from "@/lib/operatorAuth";
import { publishStage } from "@/lib/pubsub";
import { z } from "zod";

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com"]);

function parseYouTubeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!YOUTUBE_HOSTS.has(url.hostname)) return null;
    const id = url.hostname === "youtu.be"
      ? url.pathname.slice(1)
      : url.searchParams.get("v") ?? url.pathname.split("/shorts/")[1]?.split("/")[0];
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

const createJobSchema = z.object({
  youtubeUrl: z.string().url(),
  platforms: z.array(z.enum(["x"])).default(["x"]),
});

export async function GET() {
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

export async function POST(req: Request) {
  if (!isOperatorAuthorized(req)) return operatorForbidden();
  const body = await req.json().catch(() => null);
  const parsed = createJobSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid job", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const videoId = parseYouTubeUrl(parsed.data.youtubeUrl);
  if (!videoId) {
    return Response.json({ error: "invalid YouTube URL" }, { status: 400 });
  }
  const job = await createJob(
    { youtubeUrl: parsed.data.youtubeUrl, platforms: parsed.data.platforms },
    "ingest",
  );
  await appendEvent(job.id, "queued", `job created for video ${videoId}`, "operator");
  await publishStage(job.id, "ingest");
  return Response.json({ jobId: job.id }, { status: 201 });
}
