import { internalTenantHandler } from "@/lib/internalAuth";
import { dispatchStageOutbox } from "@/lib/stageOutboxDispatcher";
import { z } from "zod";
import { recoverPlannedWork } from "@/lib/planning/selection";
import { recoverLearning } from "@/lib/learning/repository";

const Body = z.object({ limit: z.number().int().min(1).max(100).default(20) }).strict();

async function post(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "invalid stage outbox tick" }, { status: 400 });
  await recoverPlannedWork();
  try { await recoverLearning(); } catch (error) { console.error("Learning recovery requires attention", error); }
  return Response.json({ results: await dispatchStageOutbox(parsed.data.limit) });
}

export const POST = internalTenantHandler(post);
