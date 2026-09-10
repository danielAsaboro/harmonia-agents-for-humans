import { isInternalAuthorized, unauthorized } from '@/lib/internalAuth';
import { listKnowledgeErasures, advanceKnowledgeErasure } from '@/lib/sourceKnowledgeErasure';
import { z } from 'zod';
export async function GET(req:Request){if(!isInternalAuthorized(req))return unauthorized();return Response.json({records:await listKnowledgeErasures()});}
const body=z.object({id:z.string().regex(/^[a-f0-9]{64}$/),state:z.enum(['s3_erased','sync_submitted','complete']),ingestionJobId:z.string().min(1).optional()}).strict();
export async function POST(req:Request){if(!isInternalAuthorized(req))return unauthorized();const input=body.safeParse(await req.json().catch(()=>null));if(!input.success)return Response.json({error:'invalid knowledge erasure transition'},{status:400});try{return Response.json({record:await advanceKnowledgeErasure(input.data.id,input.data.state,input.data.ingestionJobId)});}catch(e){return Response.json({error:e instanceof Error?e.message:'knowledge erasure failed'},{status:409});}}
