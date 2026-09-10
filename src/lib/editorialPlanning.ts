import type { ContentItem, EditorialPlanningSnapshot, Job } from "./types";
import { buildStrategySourceBinding } from "./strategy/sourceBinding";
import { planningPolicySchema, type PlanningPolicy } from "./campaigns/contracts";

const HOUR_MS = 60 * 60 * 1000;

export function buildEditorialPlanningSnapshot(
  job: Job,
  items: ContentItem[],
  asOf = new Date().toISOString(),
  configured?: { policy: PlanningPolicy; assetReadiness: EditorialPlanningSnapshot["assetReadiness"]; blockedDependencies: EditorialPlanningSnapshot["blockedDependencies"]; plannedCommitments?: EditorialPlanningSnapshot["existingCommitments"] },
): EditorialPlanningSnapshot {
  if (!configured) throw new Error("configured planning policy required");
  const policy = configured.policy;
  planningPolicySchema.parse({ timezone: policy.timezone, productionCapacity: policy.productionCapacity, cadenceConstraints: policy.cadenceConstraints, maxConcurrentItems: policy.maxConcurrentItems });
  if (policy.ref.workspaceId !== job.workspaceId || policy.ref.brandId !== job.brandId) throw new Error("planning policy tenant mismatch");
  const strategy = job.contentStrategy;
  const approval = job.strategyApproval;
  const revision = job.editorialPlanRevision ?? 1;
  if (!job.strategyRef || job.strategyRef.digest !== job.strategyDigest || job.strategyRef.strategyId !== strategy?.strategyId) throw new Error("pinned strategy reference required for editorial planning snapshot");
  if (!strategy || !job.strategyDigest || approval?.decision !== "approved") {
    throw new Error("approved strategy required for editorial planning snapshot");
  }
  if (approval.payloadDigest !== job.strategyDigest || approval.revision !== job.strategyRevision) {
    throw new Error("strategy approval binding mismatch");
  }
  const start = new Date(approval.decidedAt);
  const end = new Date(start.getTime() + strategy.horizonWeeks * 7 * 24 * HOUR_MS);
  const supported = strategy.channelRoles.filter((role) => role.operationallySupported);
  if (!supported.length) throw new Error("approved strategy has no supported planning channel");

  const relevant = items.filter((item) => {
    if (!item.scheduledFor || item.status === "cancelled") return false;
    const at = Date.parse(item.scheduledFor);
    return at >= start.getTime() && at < end.getTime();
  });
  const provenanceIds = new Set<string>([`policy:${policy.ref.id}:v${policy.ref.revision}`, `strategy:${job.strategyDigest}`]);
  for (const item of relevant) provenanceIds.add(`content-item:${item.id}`);
  const plannedCommitments = (configured.plannedCommitments ?? []).filter(item => Date.parse(item.publicationWindowStartAt) >= start.getTime() && Date.parse(item.publicationWindowStartAt) < end.getTime());
  for (const item of plannedCommitments) provenanceIds.add(item.id);

  return {
    sourceBinding: buildStrategySourceBinding(job),
    snapshotId: `planning-${job.id}-v${revision}`,
    asOf,
    horizonStartAt: start.toISOString(),
    horizonEndAt: end.toISOString(),
    timezone: policy.timezone,
    channelCapabilities: supported.map((role) => ({ channel: role.channel, formats: role.formats })),
    existingCommitments: [...plannedCommitments, ...relevant.flatMap((item) => item.platforms.map((channel) => ({
      id: `commitment:${item.id}:${channel}`,
      channel,
      publicationWindowStartAt: new Date(item.scheduledFor!).toISOString(),
      publicationWindowEndAt: new Date(Date.parse(item.scheduledFor!) + HOUR_MS).toISOString(),
    })))],
    productionCapacity: policy.productionCapacity,
    cadenceConstraints: policy.cadenceConstraints,
    postingWindowObservations: [],
    assetReadiness: configured.assetReadiness,
    blockedDependencies: configured.blockedDependencies,
    calendarProjection: relevant.map((item) => ({
      id: `calendar:${item.id}`,
      contentItemId: item.id,
      state: item.googleCalendarSync?.status ?? "not_projected",
      ...(item.googleCalendarSync?.eventId ? { externalEventId: item.googleCalendarSync.eventId } : {}),
      evidenceRefs: [`content-item:${item.id}`],
    })),
    provenanceIds: [...provenanceIds].sort(),
  };
}
