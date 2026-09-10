import { createHash } from "node:crypto";
import { z } from "zod";
import { awsRepository, recordKey, partition, ordered } from "../dynamo";
import { currentTenant, tenantCollectionPath } from "../tenancy";
import { observationSchema, reflectionSchema, hypothesisSchema, experimentSchema, autonomyCycleSchema } from "./contracts";
import { buildWakeupAgenda } from "./agenda";
import { createImmutableResidentRecord } from "./repository";

type DreamGraph = { reflections: Array<{id:string;evidence_refs:string[]}>; hypotheses:Array<{id:string;reflection_id:string;evidence_refs:string[];contradiction_refs?:string[]}>; experiments:Array<{id:string;hypothesis_id:string}> };
const graphSchema = z.object({reflections:z.array(z.object({id:z.string().min(1),evidence_refs:z.array(z.string()).min(1)}).passthrough()).max(100), hypotheses:z.array(z.object({id:z.string().min(1),reflection_id:z.string().min(1),evidence_refs:z.array(z.string()).min(1),contradiction_refs:z.array(z.string())}).passthrough()).max(100), experiments:z.array(z.object({id:z.string().min(1),hypothesis_id:z.string().min(1)}).passthrough()).max(50),safe_activity_summary:z.string().min(1).max(2000)}).strict();
const runSchema = z.object({id:z.string(),workspaceId:z.string(),brandId:z.string(), observations:z.array(observationSchema).max(500), observationIds:z.array(z.string()).max(500),state:z.enum(["sealed","dispatched","completed"]),createdAt:z.string(),reservedUsd:z.string().optional(),output:z.record(z.string(),z.unknown()).optional(),safeActivitySummary:z.string().optional(),experimentIds:z.array(z.string()).optional(),projectionsComplete:z.boolean().optional()}).passthrough();
const budgetSchema=z.object({estimatedUsd:z.string().default("0"),reservedUsd:z.string().default("0"),limitUsd:z.string()});
const key=(collection:string,id:string)=>recordKey(`${tenantCollectionPath(currentTenant(),collection)}/${id}`);
const scoped=(row:{workspaceId?:unknown;brandId?:unknown})=>row.workspaceId===currentTenant().workspaceId&&row.brandId===currentTenant().brandId;
const assertScope=(row:{workspaceId?:unknown;brandId?:unknown})=>{if(!scoped(row))throw new Error("resident record belongs to another tenant scope");};
const micros=(value:unknown)=>{if(typeof value!=="string"||!/^\d+(\.\d{1,6})?$/.test(value))throw new Error("invalid budget amount");const [whole,fraction=""]=value.split(".");return BigInt(whole)*BigInt(1000000)+BigInt(fraction.padEnd(6,"0"));};
const money=(value:bigint)=>{if(value<BigInt(0))throw new Error("resident budget invariant violated");return `${value/BigInt(1000000)}.${(value%BigInt(1000000)).toString().padStart(6,"0")}`;};
const snakeToCamel=(row:Record<string,unknown>)=>Object.fromEntries(Object.entries(row).filter(([,v])=>v!==null).map(([k,v])=>[k.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase()),v]));
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,v)=>v&&typeof v==="object"&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const projectionId=(cycleId:string,kind:string,id:string)=>createHash("sha256").update(`${cycleId}\n${kind}\n${id}`).digest("hex");
type Transaction=Parameters<Parameters<ReturnType<typeof awsRepository>["atomic"]>[0]>[0];

export function validateDreamEvidence(output:DreamGraph, observationIds:string[]) {
  const evidence=new Set(observationIds),reflections=new Set(output.reflections.map(r=>r.id)),hypotheses=new Set(output.hypotheses.map(h=>h.id));
  if(reflections.size!==output.reflections.length||hypotheses.size!==output.hypotheses.length||new Set(output.experiments.map(e=>e.id)).size!==output.experiments.length)throw new Error("duplicate dream identifier");
  for(const item of [...output.reflections,...output.hypotheses])if(!Array.isArray(item.evidence_refs)||!item.evidence_refs.length||item.evidence_refs.some(ref=>!evidence.has(ref)))throw new Error("dream evidence outside sealed input");
  for(const item of output.hypotheses)if(!reflections.has(item.reflection_id)||item.contradiction_refs?.some(ref=>!evidence.has(ref)))throw new Error("invalid reflection or contradiction evidence");
  for(const item of output.experiments)if(!hypotheses.has(item.hypothesis_id))throw new Error("unknown dream hypothesis");
}
async function assertClaim(tx:Transaction,cycleId:string,claimToken:string,kind:"dream_cycle"|"wakeup_call"="dream_cycle",immutableReplay=false) {
  const row=await tx.read(key("autonomy_cycles",cycleId)),cycle=autonomyCycleSchema.parse(row.value);
  assertScope(cycle);
  if(cycle.type!==kind||cycle.leaseTokenDigest!==createHash("sha256").update(claimToken).digest("hex"))throw new Error("resident cycle claim invalid");
  if(!immutableReplay&&(cycle.state!=="running"||!cycle.leaseExpiresAt||Date.parse(cycle.leaseExpiresAt)<=Date.now()))throw new Error("resident cycle claim expired or invalid");
  return cycle;
}
export async function sealDreamInput(cycleId:string,claimToken:string) {
  return awsRepository().atomic(async tx=>{
    await assertClaim(tx,cycleId,claimToken);
    const ref=key("autonomy_dream_runs",cycleId),existing=await tx.read(ref);
    if(existing.present){const run=runSchema.parse(existing.value);assertScope(run);return run;}
    const rows=await tx.read(ordered(partition(tenantCollectionPath(currentTenant(),"autonomy_observations")),"observedAt","desc"));
    const previous=await tx.read(partition(tenantCollectionPath(currentTenant(),"autonomy_dream_runs")));
    const used=new Set(previous.rows.filter(r=>r.value&&scoped(r.value)&&r.value.state!=="sealed").flatMap(r=>runSchema.parse(r.value).observationIds));
    const observations=rows.rows.filter(r=>r.value&&scoped(r.value)).map(r=>observationSchema.parse(r.value)).filter(o=>o.verified&&o.authorized&&o.provenance==="verified_live"&&!used.has(o.id)).slice(0,500);
    const stored={id:cycleId,workspaceId:currentTenant().workspaceId,brandId:currentTenant().brandId,observations,observationIds:observations.map(o=>o.id),state:"sealed" as const,createdAt:new Date().toISOString()};
    tx.insert(ref,stored);return stored;
  });
}
export async function reserveDream(cycleId:string,claimToken:string) {
  const configured=process.env.DREAM_MAX_COST_USD;
  if(process.env.HARMONIA_ALLOW_PAID_AWS!=="true"||!configured)return {accepted:false,reason:"paid synthesis is not configured or authorized"};
  const amount=micros(configured);if(amount<=BigInt(0))throw new Error("dream reservation must be positive");
  return awsRepository().atomic(async tx=>{
    await assertClaim(tx,cycleId,claimToken);
    const ref=key("autonomy_dream_runs",cycleId),row=await tx.read(ref),run=runSchema.parse(row.value);assertScope(run);
    if(run.state!=="sealed")return {accepted:false,reason:"synthesis already dispatched; reconcile existing run"};
    if(!run.observationIds.length)return {accepted:false,reason:"no eligible evidence"};
    // Another cycle may have reserved these observations since this input was sealed.
    const prior=await tx.read(partition(tenantCollectionPath(currentTenant(),"autonomy_dream_runs")));
    if(prior.rows.some(r=>r.id!==cycleId&&r.value&&scoped(r.value)&&r.value.state!=="sealed"&&runSchema.parse(r.value).observationIds.some(id=>run.observationIds.includes(id))))return {accepted:false,reason:"evidence already reserved by another cycle"};
    const ws=recordKey(`workspaces/${currentTenant().workspaceId}`),workspace=await tx.read(ws),budget=budgetSchema.parse(workspace.value?.budget);
    if(micros(budget.estimatedUsd)+micros(budget.reservedUsd)+amount>micros(budget.limitUsd))return {accepted:false,reason:"workspace budget exhausted"};
    tx.patch(ws,{"budget.reservedUsd":money(micros(budget.reservedUsd)+amount)});
    tx.patch(ref,{state:"dispatched",reservedUsd:money(amount),dispatchedAt:new Date().toISOString()});return {accepted:true};
  });
}
export async function persistDream(cycleId:string,claimToken:string,raw:Record<string,unknown>) {
  const scope={workspaceId:currentTenant().workspaceId,brandId:currentTenant().brandId};
  const row=await awsRepository().read(key("autonomy_dream_runs",cycleId)),run=runSchema.parse(row.value);assertScope(run);
  const output=graphSchema.parse(raw);validateDreamEvidence(output as unknown as DreamGraph,run.observationIds);
  // Every projection is typed before accepting the result. Host-assigned identities cannot collide across cycles.
  const reflections=output.reflections.map(r=>reflectionSchema.parse({...snakeToCamel(r),...scope,cycleId,id:projectionId(cycleId,"reflection",String(r.id))}));
  const hypotheses=output.hypotheses.map(h=>hypothesisSchema.parse({...snakeToCamel(h),...scope,id:projectionId(cycleId,"hypothesis",String(h.id)),reflectionId:projectionId(cycleId,"reflection",String(h.reflection_id))}));
  const experiments=output.experiments.map(e=>experimentSchema.parse({...snakeToCamel(e),...scope,id:projectionId(cycleId,"experiment",String(e.id)),hypothesisId:projectionId(cycleId,"hypothesis",String(e.hypothesis_id)),state:"candidate"}));
  await awsRepository().atomic(async tx=>{
    const ref=key("autonomy_dream_runs",cycleId),current=runSchema.parse((await tx.read(ref)).value);assertScope(current);
    if(current.state==="completed"){
      if(canonical(current.output)!==canonical(output))throw new Error("dream result immutable");
      await assertClaim(tx,cycleId,claimToken,"dream_cycle",true);return;
    }
    await assertClaim(tx,cycleId,claimToken);
    if(current.state!=="dispatched")throw new Error("dream was not reserved for synthesis");
    const ws=recordKey(`workspaces/${scope.workspaceId}`),workspace=await tx.read(ws),budget=budgetSchema.parse(workspace.value?.budget),reserved=micros(current.reservedUsd);
    tx.patch(ws,{"budget.reservedUsd":money(micros(budget.reservedUsd)-reserved),"budget.estimatedUsd":money(micros(budget.estimatedUsd)+reserved)});
    tx.patch(ref,{state:"completed",output,safeActivitySummary:output.safe_activity_summary,experimentIds:experiments.map(e=>e.id),projectionsComplete:false,completedAt:new Date().toISOString()});
  });
  for(const item of reflections)await createImmutableResidentRecord("reflections",item);
  for(const item of hypotheses)await createImmutableResidentRecord("hypotheses",item);
  for(const item of experiments)await createImmutableResidentRecord("experiments",item);
  await awsRepository().atomic(async tx=>{const ref=key("autonomy_dream_runs",cycleId),current=runSchema.parse((await tx.read(ref)).value);assertScope(current);if(canonical(current.output)!==canonical(output))throw new Error("dream result immutable");tx.patch(ref,{projectionsComplete:true});});
  return {completed:true};
}
export async function latestDream() {
  const rows=await awsRepository().query(ordered(partition(tenantCollectionPath(currentTenant(),"autonomy_dream_runs")),"createdAt","desc"));
  const row=rows.rows.find(r=>r.value&&scoped(r.value)&&r.value.state==="completed"&&r.value.projectionsComplete===true);
  return row?runSchema.parse(row.value):null;
}

const wakeupSchema=z.object({id:z.string(),workspaceId:z.string(),brandId:z.string(),dream:runSchema.nullable(),operations:z.object({failedJobs:z.array(z.string()),pendingApprovals:z.array(z.string()),budgetAvailable:z.boolean(),providerHealth:z.literal("unknown")}),agenda:z.unknown().optional(),items:z.unknown().optional(),persisted:z.boolean().optional()}).passthrough();
export async function sealWakeupInput(cycleId:string,claimToken:string) {
  return awsRepository().atomic(async tx=>{
    await assertClaim(tx,cycleId,claimToken,"wakeup_call");
    const ref=key("autonomy_wakeup_runs",cycleId),existing=await tx.read(ref);
    if(existing.present){const snapshot=wakeupSchema.parse(existing.value);assertScope(snapshot);return snapshot;}
    const dreams=await tx.read(ordered(partition(tenantCollectionPath(currentTenant(),"autonomy_dream_runs")),"createdAt","desc"));
    const latest=dreams.rows.find(r=>r.value&&scoped(r.value)&&r.value.state==="completed"&&r.value.projectionsComplete===true);
    const jobs=await tx.read(partition(tenantCollectionPath(currentTenant(),"jobs")));
    const eligible=jobs.rows.filter(r=>r.value&&scoped(r.value));
    const workspace=await tx.read(recordKey(`workspaces/${currentTenant().workspaceId}`)),budget=budgetSchema.parse(workspace.value?.budget);
    const snapshot={id:cycleId,workspaceId:currentTenant().workspaceId,brandId:currentTenant().brandId,dream:latest?runSchema.parse(latest.value):null,operations:{failedJobs:eligible.filter(r=>r.value?.status==="failed").slice(0,75).map(r=>r.id),pendingApprovals:eligible.filter(r=>["awaiting_approval","awaiting_strategy_approval"].includes(String(r.value?.stage))).slice(0,75).map(r=>r.id),budgetAvailable:micros(budget.estimatedUsd)+micros(budget.reservedUsd)<micros(budget.limitUsd),providerHealth:"unknown" as const}};
    tx.insert(ref,snapshot);return snapshot;
  });
}
export async function persistWakeup(cycleId:string,claimToken:string,briefing:string,items:Parameters<typeof buildWakeupAgenda>[0]["items"]) {
  const row=await awsRepository().read(key("autonomy_wakeup_runs",cycleId)),snapshot=wakeupSchema.parse(row.value);assertScope(snapshot);
  const expected=new Map<string,{id:string;authority:"propose"|"request_attention";title:string}>();
  for(const id of snapshot.dream?.experimentIds??[])expected.set(`experiment:${id}`,{id,authority:"propose",title:"Review bounded experiment"});
  for(const id of snapshot.operations.failedJobs)expected.set(`failed:${id}`,{id,authority:"request_attention",title:"Resolve failed job"});
  for(const id of snapshot.operations.pendingApprovals)expected.set(`approval:${id}`,{id,authority:"request_attention",title:"Review pending approval"});
  const expectedBriefing=`${snapshot.dream?.safeActivitySummary??"No new nightly synthesis was recorded."} Budget ${snapshot.operations.budgetAvailable?"available":"unavailable"}; provider health unknown.`;
  if(briefing!==expectedBriefing||items.length!==expected.size||new Set(items.map(i=>i.key)).size!==items.length)throw new Error("wakeup differs from sealed evidence");
  for(const item of items){const ref=expected.get(item.key);if(!ref||item.title!==ref.title||item.authority!==ref.authority||canonical(item.evidenceRefs)!==canonical([ref.id])||item.estimatedCostUsd!==0||item.risk!=="low")throw new Error("wakeup item outside sealed evidence");}
  const cycle=await awsRepository().atomic(tx=>assertClaim(tx,cycleId,claimToken,"wakeup_call",true));
  const {workspaceId,brandId}=currentTenant();
  const deadline=new Date(Date.parse(cycle.scheduledAt)+86400000).toISOString();
  if(items.some(i=>Date.parse(i.deadline)!==Date.parse(deadline)))throw new Error("wakeup deadline outside sealed window");
  const result=buildWakeupAgenda({workspaceId,brandId,cycleId,scheduledFor:cycle.scheduledAt,createdAt:cycle.scheduledAt,briefing,items:items.map(i=>({...i,deadline}))});
  await createImmutableResidentRecord("agendas",result.agenda);
  for(const item of result.items)await createImmutableResidentRecord("agenda_items",item);
  await awsRepository().atomic(async tx=>{await assertClaim(tx,cycleId,claimToken,"wakeup_call",true);const ref=key("autonomy_wakeup_runs",cycleId);await tx.read(ref);tx.patch(ref,{persisted:true});});
  return result;
}
