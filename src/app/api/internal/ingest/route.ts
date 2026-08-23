import { ingestSubmissionSchema } from "@/lib/contracts";
import { appendEvent, saveIngestMeta } from "@/lib/firestore";
import { internalRoute } from "@/lib/internalHandler";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";
import { advance } from "@/lib/advance";

export async function POST(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  return internalRoute(req, ingestSubmissionSchema, async (body) => {
    await saveIngestMeta(body.jobId, {
      videoId: body.videoId, title: body.title,
      channel: body.channel, durationSec: body.durationSec,
      mediaDigest: body.mediaDigest,
    });
    await appendEvent(
      body.jobId,
      "ingest",
      `ingested YouTube video "${body.title}" by ${body.channel} (${Math.round(body.durationSec)}s, media sha256 ${body.mediaDigest.slice(0, 12)}…, ${body.mediaBytes} bytes)`,
      "agent",
    );
    return advance(body.jobId, "ingest", "source ingested; transcribing");
  });
}
