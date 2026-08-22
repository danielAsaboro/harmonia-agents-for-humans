import { z } from "zod";
import {
  appendEvent,
  getJob,
  markActionExecuted,
  recordApproval,
  setStage,
} from "@/lib/firestore";
import { isOperatorAuthorized, operatorForbidden } from "@/lib/operatorAuth";
import { publishStage } from "@/lib/pubsub";

const decisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  actor: z.string().min(1).default("operator"),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; actionId: string }> },
) {
  const { id, actionId } = await params;
  if (!isOperatorAuthorized(req)) return operatorForbidden();
  const body = await req.json().catch(() => ({}));
  const parsed = decisionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid decision" }, { status: 400 });
  }
  const jobBefore = await getJob(id);
  const action = await recordApproval(id, actionId, parsed.data.decision);
  await appendEvent(
    id,
    jobBefore.stage,
    `${parsed.data.decision} action '${action.title}' (${action.type})`,
    "operator",
  );

  const job = await getJob(id);
  if (job.stage !== "awaiting_approval") {
    return Response.json({ ok: true, note: "job not awaiting approval" });
  }

  const stillPending = job.actions.filter((a) => a.approvalState === "pending");
  if (stillPending.length > 0) {
    return Response.json({ ok: true, remainingApprovals: stillPending.length });
  }

  const executable = job.actions.filter(
    (a) =>
      a.state === "planned" &&
      (!a.requiresApproval || a.approvalState === "approved"),
  );
  for (const a of job.actions) {
    if (a.approvalState === "rejected" && a.state === "planned") {
      await markActionExecuted(id, a.id, "skipped");
      await appendEvent(id, "awaiting_approval", `action skipped by rejection: ${a.title}`, "system");
    }
  }

  if (executable.length > 0) {
    await setStage(id, "act");
    await appendEvent(id, "awaiting_approval", `${executable.length} approved action(s) dispatched`, "system");
    await publishStage(id, "act");
    return Response.json({ ok: true, triggered: "act" });
  }

  await setStage(id, "verify");
  await appendEvent(id, "awaiting_approval", "no executable actions; proceeding to verification of existing evidence", "system");
  await publishStage(id, "verify");
  return Response.json({ ok: true, triggered: "verify" });
}
