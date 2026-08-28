import { appendEvent, getJob, saveContentPack } from "@/lib/firestore";
import { internalTenantHandler } from "@/lib/internalAuth";

const packSchema = z.object({
  jobId: z.string().min(1),
  markdown: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});

import { z } from "zod";

async function post(req: Request) {
  const bodyJson = await req.json().catch(() => null);
  const parsed = packSchema.safeParse(bodyJson);
  if (!parsed.success) {
    return Response.json({ error: "invalid payload" }, { status: 400 });
  }
  const job = await getJob(parsed.data.jobId);
  if (job.stage !== "publish") {
    return Response.json({ error: `job stage is '${job.stage}'` }, { status: 409 });
  }
  await saveContentPack(parsed.data.jobId, parsed.data.markdown, parsed.data.digest);
  await appendEvent(parsed.data.jobId, "publish", `content pack stored (sha256 ${parsed.data.digest.slice(0, 12)}…)`, "agent");
  return Response.json({ ok: true });
}

export const POST = internalTenantHandler(post);
