import { z } from "zod";
import { internalTenantHandler } from "@/lib/internalAuth";
import { appendEvent, getJob } from "@/lib/repository";
import { mediaProposalSummary, planRequestedMediaProduction } from "@/lib/outputMediaProduction";
import { getProductionPlanWorkspaceForJob, proposeProductionPlan, sealProductionPlan } from "@/lib/productionPlanStore";
import { productionPlanError } from "@/lib/productionPlanHttp";

const bodySchema = z.object({ jobId: z.string().min(1) }).strict();

async function post(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid media-production proposal request" }, { status: 400 });
  try {
    const job = await getJob(parsed.data.jobId);
    if (!job.campaignOutputPlan) throw new Error("campaign output plan is required before media production");
    const existing = await getProductionPlanWorkspaceForJob(job.id);
    if (existing?.revision.plan.outputRequest?.outputPlanDigest === job.campaignOutputPlan.digest) {
      return Response.json({ outcome: "already_proposed", proposal: mediaProposalSummary(existing.revision.plan), state: existing.aggregate.state });
    }
    const plan = planRequestedMediaProduction({ job, outputPlan: job.campaignOutputPlan, revision: (existing?.revision.plan.revision ?? 0) + 1 });
    if (!plan) return Response.json({ outcome: "not_requested" });
    await proposeProductionPlan(plan);
    const sealed = await sealProductionPlan(plan.id, { planDigest: mediaProposalSummary(plan).planDigest });
    await appendEvent(job.id, job.stage, `Prepared exact media proposal ${plan.id} revision ${plan.revision} for operator review.`, "agent");
    return Response.json({ outcome: "proposed", proposal: mediaProposalSummary(plan), state: sealed.state }, { status: 201 });
  } catch (error) {
    return productionPlanError(error);
  }
}

export const POST = internalTenantHandler(post);
