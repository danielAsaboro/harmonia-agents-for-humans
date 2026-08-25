import { strategySubmissionSchema } from "@/lib/contracts";
import { acceptStrategyProposal, appendEvent, createNotification, getJob } from "@/lib/firestore";
import { internalRoute } from "@/lib/internalHandler";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";
import { strategyDigest } from "@/lib/strategyApproval";
import { sendTelegramStrategyApproval } from "@/lib/telegramStrategyApproval";

export async function POST(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  return internalRoute(req, strategySubmissionSchema, async (body) => {
    const job = await getJob(body.jobId);
    const digest = strategyDigest(body.strategy);
    let accepted: Awaited<ReturnType<typeof acceptStrategyProposal>>;
    try {
      accepted = await acceptStrategyProposal(body.jobId, body.strategy, digest, body.revision);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 409 });
    }
    await appendEvent(body.jobId, "strategize", `Ryan strategy v${body.revision} awaiting digest-bound approval`, "agent");
    await createNotification({
      kind: "approval_needed", title: "Strategy approval needed",
      body: `${job.ingestedTitle ?? body.jobId} has a four-week strategy proposal waiting for review.`,
      severity: "warning", refType: "job", refId: body.jobId, href: "/dashboard",
      createdAt: new Date().toISOString(),
    });
    try {
      await sendTelegramStrategyApproval(body.jobId, job.ingestedTitle ?? body.jobId, digest, accepted.expiresAt);
    } catch (error) {
      console.error("Telegram strategy approval notification failed", { jobId: body.jobId, errorType: error instanceof Error ? error.name : "unknown" });
    }
    return Response.json({ ok: true, digest, awaitingStrategyApproval: true });
  });
}
