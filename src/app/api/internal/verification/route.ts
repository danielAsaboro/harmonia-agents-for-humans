import { verificationSubmissionSchema } from "@/lib/contracts";
import {
  appendEvent,
  getJob,
  listReceipts,
  savePacket,
  saveVerifications,
} from "@/lib/firestore";
import { internalRoute } from "@/lib/internalHandler";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";
import { assemblePacket } from "@/lib/packet";
import type { VerificationResult } from "@/lib/types";

export async function POST(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  return internalRoute(req, verificationSubmissionSchema, async (body) => {
    const job = await getJob(body.jobId);
    if (job.stage !== "verify") {
      return Response.json(
        { error: `job stage is '${job.stage}', verification accepted at 'verify'` },
        { status: 409 },
      );
    }
    const results: VerificationResult[] = body.results.map((r) => ({
      ...r,
      checkedAt: new Date().toISOString(),
    }));
    await saveVerifications(body.jobId, results);
    const verifiedCount = results.filter((r) => r.verified).length;
    await appendEvent(body.jobId, "verify", `verification re-checked artifacts: ${verifiedCount}/${results.length} confirmed`, "agent");

    const receipts = await listReceipts(body.jobId);
    const packet = assemblePacket({
      jobId: body.jobId,
      config: job.config,
      drafts: job.drafts,
      actions: job.actions,
      receipts,
      verifications: results,
    });
    await savePacket(body.jobId, packet);
    await appendEvent(body.jobId, "packet", `evidence packet assembled: ${verifiedCount} verified, ${packet.unresolved.length} unresolved gap(s)`, "system");
    return Response.json({ ok: true, unresolved: packet.unresolved.length });
  });
}
