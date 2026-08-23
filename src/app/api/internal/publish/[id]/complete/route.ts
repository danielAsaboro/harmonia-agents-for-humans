import { appendEvent, getJob, setStage } from "@/lib/firestore";
import { internalTenantHandler } from "@/lib/internalAuth";
import { publishStage } from "@/lib/pubsub";
import { currentTenant } from "@/lib/tenancy";

/**
 * Completes the act stage when the worker finished executing all approved
 * actions (including the degenerate zero-action case).
 */
async function post(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (body?.stage !== "publish") {
    return Response.json({ error: "expected stage 'publish'" }, { status: 400 });
  }
  const job = await getJob(id);
  if (job.stage !== "publish") {
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
  await appendEvent(id, "publish", "action phase complete", "system");
  await publishStage(currentTenant(), id, "verify");
  return Response.json({ ok: true });
}

export const POST = internalTenantHandler(post);
