import { createHash } from 'node:crypto';
import { z } from 'zod';
import { usageRecordSchema } from './contracts';
import { finalizeUsageRecordInTransaction, resolveJobBudgetReservationInTransaction } from './repository';
import { awsRepository, recordKey, partition, where, limited } from './dynamo';
import { sourceRightsAuthorizationId, type SourceRightsAuthorization } from './sourceRights';
import { currentTenant, assertResourceWorkspace } from './tenancy';

export const knowledgeIndexInputSchema=z.object({
 estimatedCostUsd:z.string().regex(/^\d+(\.\d{1,6})?$/),pricingVersion:z.string().min(1),estimatedInputUnits:z.number().int().positive(),budgetOutcome:z.literal("not_invoked").optional(),usageRecord:usageRecordSchema.optional(),jobId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),operationId:z.string().regex(/^[a-f0-9]{64}$/),clientToken:z.string().regex(/^[a-f0-9]{64}$/),
 sourceDigest:z.string().regex(/^[a-f0-9]{64}$/),state:z.enum(['prepared','submitted','complete','failed']),
 objectUri:z.string().min(1),objectDigest:z.string().regex(/^[a-f0-9]{64}$/).optional(),
 ingestionJobId:z.string().min(1).max(200).optional(),error:z.string().min(1).max(1000).optional(),
}).strict();
export type KnowledgeIndexInput=z.infer<typeof knowledgeIndexInputSchema>;
function sourceKey(id:string){if(!/^[A-Za-z0-9_-]{1,300}$/.test(id))throw new Error('invalid source id');const t=currentTenant();return recordKey(`workspaces/${t.workspaceId}/brands/${t.brandId}/sources/${id}`);}
export async function getKnowledgeIndex(sourceId:string,sourceDigest:string){
 if(!/^[a-f0-9]{64}$/.test(sourceDigest))throw new Error('invalid source digest');
 const source=await awsRepository().read(sourceKey(sourceId));if(!source.present)throw new Error('source missing');assertResourceWorkspace(currentTenant(),source.value as {workspaceId:string;brandId:string});
 if(source.value?.state!=='ready'||source.value?.contentDigest!==sourceDigest)return null;
 const rights=await awsRepository().read(recordKey(`workspaces/${currentTenant().workspaceId}/brands/${currentTenant().brandId}/source_rights/${source.value.rightsAuthorizationId}`));
 if(!rights.present||rights.value?.revokedAt)return null;
 const row=await awsRepository().read(recordKey(sourceKey(sourceId).path+'/knowledge_index/'+sourceDigest));return row.present?row.value:null;
}
export async function updateKnowledgeIndex(sourceId:string,input:KnowledgeIndexInput){
 const scope=currentTenant(),source=sourceKey(sourceId),key=recordKey(source.path+'/knowledge_index/'+input.sourceDigest);
 const prefix=`s3://${process.env.S3_BUCKET}/knowledge/${scope.workspaceId}/${scope.brandId}/${sourceId}/`;
 if(!process.env.S3_BUCKET||input.objectUri!==prefix+input.sourceDigest+'.txt')throw new Error('knowledge object outside source scope');
 const clientToken=createHash('sha256').update(`knowledge-index\0${scope.workspaceId}\0${scope.brandId}\0${sourceId}\0${input.sourceDigest}`).digest('hex');
 if(input.operationId!==clientToken||input.clientToken!==clientToken)throw new Error('knowledge operation identity mismatch');
 return awsRepository().atomic(async tx=>{
  const [snapshot,current]=await Promise.all([tx.read(source),tx.read(key)]);
  if(current.present&&input.state==='failed'&&input.budgetOutcome==='not_invoked'){
   const prior=current.value!;
   assertResourceWorkspace(scope,prior as {workspaceId:string;brandId:string});
   if(prior.jobId!==input.jobId||prior.objectUri!==input.objectUri||prior.operationId!==clientToken||prior.clientToken!==clientToken||prior.estimatedCostUsd!==input.estimatedCostUsd||prior.pricingVersion!==input.pricingVersion||prior.estimatedInputUnits!==input.estimatedInputUnits||input.ingestionJobId||prior.ingestionJobId)throw new Error('knowledge undispatched release identity mismatch');
   if(prior.state==='failed'&&prior.budgetOutcome==='not_invoked')return prior;
   if(prior.state!=='prepared')throw new Error('knowledge dispatch cannot be released');
   await resolveJobBudgetReservationInTransaction(tx,{jobId:input.jobId,operationId:clientToken,outcome:'not_invoked',reason:input.error??'knowledge source not dispatched'});
   const next={...prior,...input,updatedAt:new Date().toISOString()};tx.put(key,next);return next;
  }
  if(!snapshot.present)throw new Error('source missing');assertResourceWorkspace(scope,snapshot.value as {workspaceId:string;brandId:string});
  if(snapshot.value?.state!=='ready'||!snapshot.value?.rightsAuthorizationId||snapshot.value?.contentDigest!==input.sourceDigest)throw new Error('source authority changed or not ready');
  const rights = await tx.read(recordKey(`workspaces/${scope.workspaceId}/brands/${scope.brandId}/source_rights/${snapshot.value.rightsAuthorizationId}`));
  if (!rights.present || rights.value?.revokedAt) throw new Error('source rights record missing or revoked');
  assertResourceWorkspace(scope, rights.value as {workspaceId:string;brandId:string});
  const r=rights.value!;
  const authorization={version:r.version,sourceKind:r.sourceKind,attestedBySubjectId:r.attestedBySubjectId,authenticationId:r.authenticationId,channel:r.channel,attestedAt:r.attestedAt} as SourceRightsAuthorization;
  if(authorization.version!=='source-rights-v1'||authorization.sourceKind!==snapshot.value.provider||sourceRightsAuthorizationId(authorization)!==snapshot.value.rightsAuthorizationId)throw new Error('source rights record integrity mismatch');
  const job=await tx.read(recordKey(`workspaces/${scope.workspaceId}/jobs/${input.jobId}`));
  if(!job.present||job.value?.brandId!==scope.brandId||!job.value?.config)throw new Error('source outside indexing job');
  const manifest=await tx.read(recordKey(`workspaces/${scope.workspaceId}/jobs/${input.jobId}/source_manifests/${(job.value!.config as {sourceManifestId:string}).sourceManifestId}`));
  if(!manifest.present||!(manifest.value?.directSourceIds as string[]|undefined)?.includes(sourceId)||(manifest.value?.excludedSourceIds as string[]|undefined)?.includes(sourceId))throw new Error('source outside sealed job manifest');
  if(current.present){
   const prior=current.value!;
   if(prior.jobId!==input.jobId&&input.state!=='prepared')throw new Error('knowledge job binding changed');
   if(prior.estimatedCostUsd!==input.estimatedCostUsd||prior.pricingVersion!==input.pricingVersion||prior.estimatedInputUnits!==input.estimatedInputUnits)throw new Error('knowledge estimate binding changed');
   if(prior.objectUri!==input.objectUri||prior.objectDigest!==input.objectDigest)throw new Error('knowledge index immutable identity conflict');
   if(input.state==='prepared')return prior;
   if(prior.state==='complete'||prior.state==='failed'){if(prior.state===input.state&&prior.ingestionJobId===input.ingestionJobId)return prior;throw new Error('knowledge index is terminal');}
   if(input.state==='submitted'&&(!input.ingestionJobId||prior.ingestionJobId&&prior.ingestionJobId!==input.ingestionJobId))throw new Error('knowledge ingestion job conflict');
   if(input.state==='complete'&&(prior.state!=='submitted'||!input.ingestionJobId||prior.ingestionJobId!==input.ingestionJobId))throw new Error('knowledge index completion lacks submitted job');
   if(input.state==='failed'&&input.budgetOutcome==='not_invoked'){
    if(prior.state!=='prepared'||prior.ingestionJobId||input.ingestionJobId)throw new Error('knowledge dispatch cannot be released');
    await resolveJobBudgetReservationInTransaction(tx,{jobId:String(prior.jobId),operationId:clientToken,outcome:'not_invoked',reason:input.error??'knowledge source not dispatched'});
   }else if(input.state==='complete'||input.state==='failed'){
    const usage=input.usageRecord;
    if(!usage||usage.jobId!==prior.jobId||usage.operationId!==clientToken||usage.id!==`knowledge-index-${clientToken}`||usage.role!=='knowledge_index'||usage.model!=='amazon.titan-embed-text-v2:0'||usage.stage!=='extract_sources'||usage.observedCostUsd!==undefined||usage.observedCostUnavailable!==true||usage.measurementBasis!=='utf8_byte_token_upper_bound'||usage.inputUnits!==prior.estimatedInputUnits||usage.pricingVersion!==prior.pricingVersion)throw new Error('knowledge terminal usage authority missing');
    const reservation=await tx.read(recordKey(`workspaces/${scope.workspaceId}/jobs/${usage.jobId}/cost_reservations/${clientToken}`));
    if(reservation.value?.estimatedCostUsd!==usage.estimatedCostUsd)throw new Error('knowledge usage estimate differs from reservation');
    await finalizeUsageRecordInTransaction(tx,usage);
   }
   const next={...prior,...input,updatedAt:new Date().toISOString()};tx.put(key,next);return next;
  }
  if(input.state!=='prepared')throw new Error('knowledge index must be prepared before provider dispatch');
  const record={...input,workspaceId:scope.workspaceId,brandId:scope.brandId,sourceId,operationId:clientToken,clientToken,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};tx.insert(key,record);return record;
 });
}

export async function pendingKnowledgeIndexes(limit=20){
 const scope=currentTenant(), repo=awsRepository();
 const sources=await repo.query(partition(`workspaces/${scope.workspaceId}/brands/${scope.brandId}/sources`));
 const records:Record<string,unknown>[]=[];
 for(const source of sources.rows){
  if(source.value?.state!=='ready')continue;
  const rows=await repo.query(limited(where(partition(source.key.path+'/knowledge_index'),'state','in',['prepared','submitted']),Math.max(1,limit-records.length)));
  for(const row of rows.rows)if(row.value?.sourceDigest===source.value?.contentDigest)records.push(row.value!);
  if(records.length>=limit)break;
 }
 return records;
}
