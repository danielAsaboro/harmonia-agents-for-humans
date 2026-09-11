import { awsRepository, DynamoTransaction, partition, recordKey } from "../dynamo";
import { assertResourceWorkspace, currentTenant, tenantSubjectId, tenantCollectionPath } from "../tenancy";
import { requireContentOperator } from "../authority";
import { defaultMeasurements, pinnedMeasurementSchema } from "../learning/contracts";
import { sourceAnalysisDigest } from "../sourceAnalysis";
import { readStrategyRevision, type StrategyReader } from "../strategy/repository";
import { authorityRefSchema, planningPolicySchema, type AuthorityRef, type Campaign, type PlanRevision, type PlannedItem, type PlannedItemState, type PlanningAsset, type PlanningPolicy } from "./contracts";

export const campaignRoot = () => { const t = currentTenant(); return `workspaces/${t.workspaceId}/brands/${t.brandId}`; };
export function scopedRef(id: string, revision: number): AuthorityRef { const t = currentTenant(); return authorityRefSchema.parse({ workspaceId: t.workspaceId, brandId: t.brandId, id, revision }); }
export function authorityKey(collection: string, ref: AuthorityRef) { authorityRefSchema.parse(ref); assertResourceWorkspace(currentTenant(), ref); return recordKey(`${campaignRoot()}/${collection}/${ref.id}-v${ref.revision}`); }
export function pointerKey(collection: string, id: string) { scopedRef(id, 1); return recordKey(`${campaignRoot()}/${collection}/${id}`); }
export async function readRequired<T>(key: ReturnType<typeof recordKey>, reader: StrategyReader = awsRepository()): Promise<T> {
  const row = await reader.read(key); if (!row.present) throw new Error(`${key.partition.split("/").at(-1)} authority not found`);
  assertResourceWorkspace(currentTenant(), row.value as { workspaceId: string; brandId: string }); return row.value as unknown as T;
}
export async function readCampaign(ref: AuthorityRef, reader?: StrategyReader) { return readRequired<Campaign>(authorityKey("campaign_revisions", ref), reader); }
export async function readPlan(ref: AuthorityRef, reader?: StrategyReader) { return readRequired<PlanRevision>(authorityKey("plan_revisions", ref), reader); }
export function assertItemProductionContext(item: PlannedItem) {
  if (!item.measurements?.length || item.measurements.length > 8) throw new Error("planned item measurements required");
  for (const measurement of item.measurements) pinnedMeasurementSchema.parse(measurement);
  if (new Set(item.measurements.map(m => m.definition.id)).size !== item.measurements.length) throw new Error("duplicate planned measurement");
  assertResourceWorkspace(currentTenant(), item.productionContext.policyRef);
  if (item.productionContext.mode !== item.evidence.mode || item.productionContextDigest !== sourceAnalysisDigest({ evidence: item.evidence, context: item.productionContext })) throw new Error("planned item production context digest mismatch");
  if (item.productionContext.mode === "source_intake" && item.evidence.mode === "source_intake") {
    if (!item.productionContext.sourceInputs.length || sourceAnalysisDigest(item.productionContext.sourceInputs) !== sourceAnalysisDigest(item.evidence.sourceInputs) || sourceAnalysisDigest(item.productionContext.sourceAuthority) !== item.evidence.authorityDigest) throw new Error("planned source intake authority mismatch");
  }
  if (item.productionContext.mode === "source_backed" && item.evidence.mode === "source_backed") {
    if (sourceAnalysisDigest(item.productionContext.sourceAnalysis) !== item.evidence.sourceBinding.analysisDigest || sourceAnalysisDigest(item.productionContext.snapshot.sourceBinding) !== sourceAnalysisDigest(item.evidence.sourceBinding)) throw new Error("planned item source context binding mismatch");
    if (sourceAnalysisDigest(item.evidence.sourceBinding.strategyRef) !== sourceAnalysisDigest(item.strategyRef) || item.evidence.sourceBinding.jobId !== item.evidence.sourceJobId) throw new Error("planned item source strategy mismatch");
  } else if (item.evidence.mode === "operator_context") {
    if (item.operatorBrief !== item.evidence.operatorBrief || item.evidence.contextDigest !== sourceAnalysisDigest(item.operatorBrief)) throw new Error("planned item operator context mismatch");
    if (Boolean(item.instructionContext) !== Boolean(item.evidence.instructionContext)
      || (item.instructionContext && item.evidence.instructionContext && sourceAnalysisDigest(item.instructionContext) !== sourceAnalysisDigest(item.evidence.instructionContext))
      || item.originalOperatorBrief !== item.evidence.originalOperatorBrief) throw new Error("planned item instruction provenance mismatch");
  }
}
export function withItemProductionContext(item: Omit<PlannedItem, "productionContextDigest" | "measurements"> & { measurements?: PlannedItem["measurements"] }): PlannedItem {
  const result = { ...item, measurements: item.measurements ?? defaultMeasurements(item.channel), productionContextDigest: sourceAnalysisDigest({ evidence: item.evidence, context: item.productionContext }) };
  assertItemProductionContext(result); return result;
}
export async function readPlannedItem(ref: AuthorityRef, reader?: StrategyReader) {
  const item = await readRequired<PlannedItem>(authorityKey("planned_item_revisions", ref), reader); assertItemProductionContext(item); return item;
}
export async function readItemState(ref: AuthorityRef, reader?: StrategyReader) { return readRequired<PlannedItemState>(authorityKey("planned_item_states", ref), reader); }
export async function currentPlan(id: string, reader: StrategyReader = awsRepository()) { const ref = await readRequired<AuthorityRef>(pointerKey("plans", id), reader); return readPlan(ref, reader); }
export async function listCurrentPlans(reader: StrategyReader = awsRepository()): Promise<PlanRevision[]> {
  const q = partition(`${campaignRoot()}/plans`);
  const page = reader instanceof DynamoTransaction ? await reader.read(q) : await awsRepository().query(q);
  if (!page.rows.length) return [];
  const revisions = partition(`${campaignRoot()}/plan_revisions`);
  const rows = reader instanceof DynamoTransaction ? await reader.read(revisions) : await awsRepository().query(revisions);
  return page.rows.map(row => {
    const ref = authorityRefSchema.parse(row.value); assertResourceWorkspace(currentTenant(), ref);
    const revision = rows.rows.find(row => row.id === `${ref.id}-v${ref.revision}`)?.value as unknown as PlanRevision;
    if (!revision || revision.ref.id !== ref.id || revision.ref.revision !== ref.revision) throw new Error("current plan revision authority missing");
    assertResourceWorkspace(currentTenant(), revision); return revision;
  });
}
export async function listCurrentCampaigns(reader: StrategyReader = awsRepository()): Promise<Campaign[]> {
  const pointers = reader instanceof DynamoTransaction ? await reader.read(partition(`${campaignRoot()}/campaigns`)) : await awsRepository().query(partition(`${campaignRoot()}/campaigns`));
  return Promise.all(pointers.rows.map(row => readCampaign(authorityRefSchema.parse(row.value), reader)));
}
export async function readPlanningPolicy(reader: StrategyReader = awsRepository()): Promise<PlanningPolicy> {
  const ref = await readRequired<AuthorityRef>(pointerKey("planning_policy", "active"), reader);
  return readRequired<PlanningPolicy>(authorityKey("planning_policy_revisions", ref), reader);
}
export async function configurePlanningPolicy(input: zPolicy, expectedRevision: number) {
  requireContentOperator(currentTenant()); const body = planningPolicySchema.parse(input);
  return awsRepository().atomic(async tx => {
    const key = pointerKey("planning_policy", "active"); const row = await tx.read(key);
    if ((row.value?.revision ?? 0) !== expectedRevision) throw new Error("stale planning policy revision");
    const ref = scopedRef("policy", expectedRevision + 1);
    const policy: PlanningPolicy = { ...body, ref, configuredAt: new Date().toISOString(), configuredBy: tenantSubjectId(currentTenant()) };
    tx.insert(authorityKey("planning_policy_revisions", ref), { ...policy, workspaceId: ref.workspaceId, brandId: ref.brandId }); tx.put(key, ref); return policy;
  });
}
type zPolicy = Parameters<typeof planningPolicySchema.parse>[0];
export async function createCampaign(input: { id: string; name: string; objective: string; strategyRef: Campaign["strategyRef"] }, expectedRevision = 0): Promise<Campaign> {
  requireContentOperator(currentTenant()); return awsRepository().atomic(tx => writeCampaign(tx, input, expectedRevision));
}
export async function writeCampaign(tx: DynamoTransaction, input: { id: string; name: string; objective: string; strategyRef: Campaign["strategyRef"] }, expectedRevision: number) {
  if (!input.name.trim() || !input.objective.trim()) throw new Error("campaign name and objective required");
  await readStrategyRevision(input.strategyRef, tx);
  const key = pointerKey("campaigns", input.id); const row = await tx.read(key);
  if ((row.value?.revision ?? 0) !== expectedRevision) throw new Error("stale campaign revision");
  const ref = scopedRef(input.id, expectedRevision + 1);
  const campaign: Campaign = { ref, workspaceId: ref.workspaceId, brandId: ref.brandId, name: input.name, objective: input.objective, strategyRef: input.strategyRef, createdAt: new Date().toISOString(), createdBy: tenantSubjectId(currentTenant()) };
  tx.insert(authorityKey("campaign_revisions", ref), campaign); tx.put(key, ref); return campaign;
}
export async function listPlanningAssets(reader: StrategyReader = awsRepository()): Promise<PlanningAsset[]> {
  const query = partition(tenantCollectionPath(currentTenant(), "artifacts"));
  const page = reader instanceof DynamoTransaction ? await reader.read(query) : await awsRepository().query(query);
  return page.rows.flatMap(row => {
    const asset = row.value as unknown as import("../artifacts").ArtifactRecord;
    if (asset.workspaceId !== currentTenant().workspaceId || asset.brandId !== currentTenant().brandId) return [];
    return [{ id: asset.id, workspaceId: asset.workspaceId, brandId: asset.brandId, briefId: asset.jobId, assetType: asset.contentType, status: asset.state === "ready" ? "ready" as const : "blocked" as const, evidenceRefs: [`artifact:${asset.id}`] }];
  });
}
