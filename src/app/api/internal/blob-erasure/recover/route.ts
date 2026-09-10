import { awsRepository } from '@/lib/dynamo';
import { isInternalAuthorized,unauthorized } from '@/lib/internalAuth';
export async function POST(req:Request){
 if(!isInternalAuthorized(req))return unauthorized();
 const result=await awsRepository().recoverPendingBlobErasures();
 return Response.json({ok:result.failed.length===0,...result},{status:result.failed.length?503:200});
}
