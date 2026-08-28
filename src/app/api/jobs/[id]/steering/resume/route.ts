import { operatorTenantHandler } from "@/lib/auth";
import { getJob } from "@/lib/firestore";
import { setJobControl } from "@/lib/steering/repository";
import { queueStageTrigger } from "@/lib/stageTrigger";
import { z } from "zod";
const schema = z.object({ expectedControlEpoch: z.number().int().nonnegative() }).strict();
async function post(request: Request, { params }: { params: Promise<{ id: string }> }) { const parsed = schema.safeParse(await request.json().catch(() => null)); if (!parsed.success) return Response.json({ error: "invalid control epoch" }, { status: 400 }); const { id } = await params; try { const job = await getJob(id); if (job.controlState !== "paused") throw new Error("only a paused job can resume"); const controlEpoch = await setJobControl(id, parsed.data.expectedControlEpoch, "running"); await queueStageTrigger(id, job.stage); return Response.json({ controlEpoch, stage: job.stage }); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "resume failed" }, { status: 409 }); } }
export const POST = operatorTenantHandler(post);
