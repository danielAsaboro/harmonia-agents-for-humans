import { createHash } from 'node:crypto';
import { awsRepository, recordKey, partition } from './dynamo';
import { currentTenant, assertResourceWorkspace, runWithTenant } from './tenancy';
import { ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { s3Client } from './storage';
import { eraseS3Versions } from './s3Erasure';

const queue=()=>partition('knowledge-erasure');
export async function revokeSourceKnowledge(sourceId:string):Promise<string|null>{
 if(!/^[A-Za-z0-9_-]{1,300}$/.test(sourceId))throw new Error('invalid source id');
 const t=currentTenant(),source=recordKey(`workspaces/${t.workspaceId}/brands/${t.brandId}/sources/${sourceId}`);
 const id=createHash('sha256').update(`knowledge-erasure\0${t.workspaceId}\0${t.brandId}\0${sourceId}`).digest('hex');
 const result = await awsRepository().atomic(async tx=>{
  const [record,indexes,existing]=await Promise.all([tx.read(source),tx.read(partition(source.path+'/knowledge_index')),tx.read(recordKey('knowledge-erasure/'+id))]);
  if(!record.present)return existing.present?id:null;
  assertResourceWorkspace(t,record.value as {workspaceId:string;brandId:string});
  tx.patch(source,{state:'excluded',updatedAt:new Date().toISOString()});
  if(indexes.empty)return null;
  if(existing.present)return id;
  tx.insert(recordKey('knowledge-erasure/'+id),{id,workspaceId:t.workspaceId,brandId:t.brandId,sourceId,bucket:process.env.S3_BUCKET,prefix:`knowledge/${t.workspaceId}/${t.brandId}/${sourceId}/`,state:'pending',clientToken:id,generation:0,notBefore:new Date(Date.now()+60_000).toISOString(),createdAt:new Date().toISOString()});return id;
 });
 const { revokeLearningObservations } = await import('./learning/repository');
 await revokeLearningObservations({sourceId}, 'Source evidence revoked');
 return result;
}
export async function revokeWorkspaceKnowledge():Promise<string[]>{
 const t=currentTenant(),registry=await awsRepository().query(partition(`partition-registry:${t.workspaceId}`)),ids:string[]=[];
 for(const row of registry.rows){const name=String(row.value?.namespace),match=new RegExp(`^workspaces/${t.workspaceId}/brands/([^/]+)/sources$`).exec(name);if(!match)continue;
  for(const source of (await awsRepository().query(partition(name))).rows){const id=await runWithTenant({...t,brandId:match[1]},()=>revokeSourceKnowledge(source.id));if(id)ids.push(id);}
 }
 return ids;
}
export async function listKnowledgeErasures(){
 const rows=await awsRepository().query(queue()),now=Date.now(),pending=[];
 for(const row of rows.rows){
  const r=row.value!;
  if(r.state==='complete'&&Date.parse(String(r.nextAuditAt??''))<=now){
   const result=await s3Client().send(new ListObjectVersionsCommand({Bucket:String(r.bucket),Prefix:String(r.prefix),MaxKeys:1}));
   if(result.Versions?.length||result.DeleteMarkers?.length){
    await awsRepository().atomic(async tx=>{const current=(await tx.read(row.key)).value!;if(current.state!=='complete')return;
     const generation=Number(current.generation??0)+1;
     tx.put(row.key,{...current,state:'pending',generation,ingestionJobId:null,clientToken:createHash('sha256').update(`${r.id}\0${generation}`).digest('hex'),notBefore:new Date(now+60_000).toISOString()});});
   }else await awsRepository().patch(row.key,{nextAuditAt:new Date(now+900_000).toISOString()});
  }else if(r.state!=='complete'&&(!r.notBefore||Date.parse(String(r.notBefore))<=now))pending.push(r);
 }
 return pending;
}
export async function advanceKnowledgeErasure(id:string,state:'s3_erased'|'sync_submitted'|'complete',ingestionJobId?:string){
 if(!/^[a-f0-9]{64}$/.test(id))throw new Error('invalid knowledge erasure id');
 const key=recordKey('knowledge-erasure/'+id),row=await awsRepository().read(key);
 if(!row.present)throw new Error('knowledge erasure missing');
 const record=row.value!;
 if(record.id!==id||typeof record.workspaceId!=='string'||typeof record.brandId!=='string'||typeof record.sourceId!=='string'||record.prefix!==`knowledge/${record.workspaceId}/${record.brandId}/${record.sourceId}/`)throw new Error('knowledge erasure scope mismatch');
 if(state==='s3_erased'&&record.state==='pending'&&Date.parse(String(record.notBefore))>Date.now())throw new Error('knowledge erasure grace period active');
 if(state==='s3_erased'&&record.state==='pending')await eraseS3Versions(String(record.bucket),String(record.prefix));
 return awsRepository().atomic(async tx=>{
  const current=(await tx.read(key)).value!;
  if(current.state===state&&(!ingestionJobId||current.ingestionJobId===ingestionJobId))return current;
  if(state==='s3_erased'&&current.state!=='pending')throw new Error('invalid knowledge erasure transition');
  if(state==='sync_submitted'&&(current.state!=='s3_erased'||!ingestionJobId))throw new Error('knowledge erasure requires S3 deletion');
  if(state==='complete'&&(current.state!=='sync_submitted'||!ingestionJobId||current.ingestionJobId!==ingestionJobId))throw new Error('knowledge erasure missing provider reconciliation');
  const next={...current,state,...(state==='complete'?{nextAuditAt:new Date(Date.now()+900_000).toISOString()}:{}),...(ingestionJobId?{ingestionJobId}:{}),updatedAt:new Date().toISOString()};tx.put(key,next);return next;
 });
}
