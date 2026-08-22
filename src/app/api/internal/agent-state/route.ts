import { z } from "zod";
import {
  getAgentState,
  setAgentState,
} from "@/lib/firestore";
import { internalRoute } from "@/lib/internalHandler";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";

/** Reads a proactive-check cadence marker. */
export async function GET(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!key) return Response.json({ error: "missing key" }, { status: 400 });
  return Response.json({ state: await getAgentState(key) });
}

const putSchema = z.object({
  key: z.string().min(1),
  // Worker emits ISO timestamps with a +00:00 offset.
  lastRunAt: z.string().datetime({ offset: true }).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

/** Records that a proactive check ran (worker cadence bookkeeping). */
export async function PUT(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  return internalRoute(req, putSchema, async (body) => {
    const clean = Object.fromEntries(
      Object.entries({ lastRunAt: body.lastRunAt, data: body.data }).filter(([, v]) => v !== undefined),
    );
    await setAgentState(body.key, clean);
    return Response.json({ ok: true });
  });
}
