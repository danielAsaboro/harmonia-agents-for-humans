import { z } from "zod";
import { administratorTenantHandler } from "@/lib/auth";
import { planningPolicySchema } from "@/lib/campaigns/contracts";
import { configurePlanningPolicy, readPlanningPolicy } from "@/lib/campaigns/repository";
const input = z.object({ policy: planningPolicySchema, expectedRevision: z.number().int().min(0) }).strict();
export const GET = administratorTenantHandler(async () => Response.json({ policy: await readPlanningPolicy() }));
export const PUT = administratorTenantHandler(async req => {
  const parsed = input.safeParse(await req.json()); if (!parsed.success) return Response.json({ error: "invalid explicit planning policy" }, { status: 400 });
  return Response.json({ policy: await configurePlanningPolicy(parsed.data.policy, parsed.data.expectedRevision) });
});
