import { administratorTenantHandler } from "@/lib/auth";
import { beginLibrarySync, getLibraryConnection } from "@/lib/brandLibraries/repository";
async function post(_request: Request, { params }: { params: Promise<{ id: string }> }) { const { id } = await params; try { const connection = await getLibraryConnection(id); const operation = await beginLibrarySync(id, connection.revision); return Response.json({ operationId: operation.id, status: "claimed" }, { status: 202 }); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "sync could not start" }, { status: 409 }); } }
export const POST = administratorTenantHandler(post);
