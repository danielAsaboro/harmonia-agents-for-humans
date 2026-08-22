import { rubricSubmissionSchema } from "@/lib/contracts";
import { appendEvent, saveRubric } from "@/lib/firestore";
import { internalRoute } from "@/lib/internalHandler";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";
import { advance } from "@/lib/advance";
import type { RubricItem } from "@/lib/types";

export async function POST(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  return internalRoute(req, rubricSubmissionSchema, async (body) => {
    const items: RubricItem[] = body.items.map((i) => ({
      ...i,
      status: "pending" as const,
    }));
    await saveRubric(body.jobId, items);
    await appendEvent(
      body.jobId,
      "normalize",
      `normalized rubric: ${items.length} requirements from ${body.sourceUrl}`,
      "agent",
    );
    return advance(body.jobId, "normalize", `rubric ready (${items.length} items); collecting evidence`);
  });
}
