import { appendEvent, getJob, setStage } from "@/lib/firestore";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";
import { publishStage } from "@/lib/pubsub";

/**
 * Completes the act stage when the worker finished executing all approved
 * actions (including the degenerate zero-action case).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isInternalAuthorized(req)) return unauthorized();
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (body?.stage !== "act") {
    return Response.json({ error: "expected stage 'act'" }, { status: 400 });
  }
  const job = await getJob(id);
  if (job.stage !== "act") {
    return Response.json({ error: `job stage is '${job.stage}'` }, { status: 409 });
  }
  const outstanding = job.actions.filter((a) => a.state === "planned");
  if (outstanding.length > 0) {
    return Response.json(
      { error: `${outstanding.length} action(s) still unreported` },
      { status: 409 },
    );
  }
  await setStage(id, "verify");
  await appendEvent(id, "act", "action phase complete", "system");
  await publishStage(id, "verify");
  return Response.json({ ok: true });
}
