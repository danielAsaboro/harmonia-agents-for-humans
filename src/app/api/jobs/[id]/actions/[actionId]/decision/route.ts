import { z } from "zod";
import { resolveDecision } from "@/lib/decisions";
import { tenantHandler } from "@/lib/auth";

const decisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  actor: z.enum(["system", "agent", "operator"]).default("operator"),
});

async function post(
  req: Request,
  { params }: { params: Promise<{ id: string; actionId: string }> },
) {
  const { id, actionId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = decisionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid decision" }, { status: 400 });
  }
  const outcome = await resolveDecision(
    id,
    actionId,
    parsed.data.decision,
    parsed.data.actor,
  );
  return Response.json(outcome);
}

export const POST = tenantHandler(post);
