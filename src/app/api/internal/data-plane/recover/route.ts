import { internalTenantHandler } from '@/lib/internalAuth';
import { awsRepository, partition } from '@/lib/dynamo';
import { currentTenant } from '@/lib/tenancy';
import { DataPlaneRepository } from '@/lib/dataPlane/repository';
import { publishDataWork } from '@/lib/dataPlane/queue';
export const POST=internalTenantHandler(async()=>{
 const scope=currentTenant(),repo=awsRepository(),data=new DataPlaneRepository(repo),now=new Date().toISOString();
 const batches=await repo.query(partition(`workspaces/${scope.workspaceId}/data_batches`));
 const published=[];
 for(const row of batches.rows){
  if(row.value?.brandId!==scope.brandId||!['pending','running'].includes(String(row.value?.state)))continue;
  const {batch,items}=await data.dispatchable(row.id,now);
  for(const item of items){
   if(published.length>=100)return Response.json({published,more:true});
   const transportMessageId=await publishDataWork(scope,{batchId:batch.id,itemId:item.id,partitionIndex:item.partitionIndex,processorVersion:item.processorVersion,manifestUri:batch.manifest.uri,manifestDigest:batch.manifest.sha256});
   await data.markDispatched(batch.id,item.id,now);published.push({batchId:batch.id,itemId:item.id,transportMessageId});
  }
 }
 return Response.json({published,more:false});
});
