import { stageExecutionFinalizeSchema } from "@/lib/contracts";
import { finalizeJobStageExecution } from "@/lib/firestore";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";
import { internalRoute } from "@/lib/internalHandler";
import { operationIdForStage } from "@/lib/operations";

export async function POST(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  return internalRoute(req, stageExecutionFinalizeSchema, async (body) => {
    return Response.json(await finalizeJobStageExecution(body));
  }, {
    requireFence: true,
    expectedOperationId: (body) => operationIdForStage(body.jobId, body.stage),
  });
}
