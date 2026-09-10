import { internalTenantHandler } from '@/lib/internalAuth';
import { getKnowledgeIndex, updateKnowledgeIndex, knowledgeIndexInputSchema } from '@/lib/sourceKnowledgeIndex';
async function get(req:Request,context:{params:Promise<{id:string}>}){const {id}=await context.params;return Response.json({record:await getKnowledgeIndex(id,new URL(req.url).searchParams.get('sourceDigest')??'')});}
async function post(req:Request,context:{params:Promise<{id:string}>}){const input=knowledgeIndexInputSchema.safeParse(await req.json().catch(()=>null));if(!input.success)return Response.json({error:'invalid knowledge index transition'},{status:400});const {id}=await context.params;return Response.json({record:await updateKnowledgeIndex(id,input.data)});}
export const GET=internalTenantHandler(get);
export const POST=internalTenantHandler(post);
