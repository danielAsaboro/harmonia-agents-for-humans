import { proposalDecisionSchema } from "@/lib/contracts";
import {
  appendEvent,
  createJob,
  decideProposal,
  getProposal,
  saveIngestMeta,
} from "@/lib/firestore";
import { operatorTenantHandler } from "@/lib/auth";
import { publishStage } from "@/lib/pubsub";
import { currentTenant } from "@/lib/tenancy";

/**
 * Operator decision on a proactive proposal. Approval composes the proposal's
 * topic + angle into an operator brief and starts a standard concept job —
 * the same pipeline and approval gates as any operator-created job.
 */
async function post(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = proposalDecisionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid payload", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { id, decision } = parsed.data;

  const proposal = await getProposal(id);
  if (!proposal) return Response.json({ error: "proposal not found" }, { status: 404 });
  if (proposal.status !== "proposed") {
    return Response.json({ error: `proposal already ${proposal.status}` }, { status: 409 });
  }

  if (decision === "rejected") {
    await decideProposal(id, "rejected");
    return Response.json({ ok: true, status: "rejected" });
  }

  const briefParts = [proposal.topic];
  if (proposal.angle) briefParts.push(`Angle: ${proposal.angle}`);
  if (proposal.reason) briefParts.push(`Why now: ${proposal.reason}`);
  if (proposal.sources.length) briefParts.push(`Sources: ${proposal.sources.join(", ")}`);
  const brief = briefParts.join("\n");

  const job = await createJob({ brief, platforms: ["x"] }, "understand");
  const title = proposal.topic.length > 60 ? `${proposal.topic.slice(0, 57)}...` : proposal.topic;
  await saveIngestMeta(job.id, { videoId: "brief", title, channel: `harmonia (${proposal.source})`, durationSec: 0 });
  await appendEvent(job.id, "understand", `concept job created from approved ${proposal.source} proposal ${proposal.id}`, "operator");
  await decideProposal(id, "approved", { jobId: job.id });
  await publishStage(currentTenant(), job.id, "understand");

  return Response.json({
    ok: true,
    status: "approved",
    jobId: job.id,
    job: { id: job.id, stage: job.stage, status: job.status },
  });
}

export const POST = operatorTenantHandler(post);
