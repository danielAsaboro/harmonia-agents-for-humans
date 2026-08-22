import { ingestSubmissionSchema } from "@/lib/contracts";
import { appendEvent } from "@/lib/firestore";
import { internalRoute } from "@/lib/internalHandler";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";
import { advance } from "@/lib/advance";

export async function POST(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  return internalRoute(req, ingestSubmissionSchema, async (body) => {
    await appendEvent(
      body.jobId,
      "ingest",
      `fetched ${body.sourceUrl} (HTTP ${body.httpStatus}, ${body.bytes} bytes, sha256 ${body.digest.slice(0, 12)}…, sections: ${body.extractedSections.join(", ") || "none"})`,
      "agent",
    );
    return advance(body.jobId, "ingest", "source ingested; normalizing rubric");
  });
}
