import { internalTenantHandler } from '@/lib/internalAuth';
import { pendingKnowledgeIndexes } from '@/lib/sourceKnowledgeIndex';
export const GET=internalTenantHandler(async(req:Request)=>Response.json({records:await pendingKnowledgeIndexes(Math.max(1,Math.min(100,Number(new URL(req.url).searchParams.get('limit')??20)||20)))}));
