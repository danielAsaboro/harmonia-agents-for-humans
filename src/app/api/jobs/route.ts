import { createJob, appendEvent, listJobs } from "@/lib/firestore";
import { isOperatorAuthorized, operatorForbidden } from "@/lib/operatorAuth";
import { publishStage } from "@/lib/pubsub";
import { z } from "zod";

const createJobSchema = z.object({
  devpostUrl: z.string().url(),
  githubRepo: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/repo"),
  cloudRunUrl: z.string().url().optional(),
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
  const [owner, repo] = parsed.data.githubRepo.split("/");
  const job = await createJob(
    {
      devpostUrl: parsed.data.devpostUrl,
      githubRepo: repo,
      githubOwner: owner,
      cloudRunUrl: parsed.data.cloudRunUrl,
    },
    "ingest",
  );
  await appendEvent(job.id, "queued", `job created for ${owner}/${repo}`, "operator");
  await publishStage(job.id, "ingest");
  return Response.json({ jobId: job.id }, { status: 201 });
}
