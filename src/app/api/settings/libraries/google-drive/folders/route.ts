import { tenantHandler } from "@/lib/auth";
import { listDriveFolders } from "@/lib/brandLibraries/googleDrive";
import { getConnection } from "@/lib/firestore";
async function get(request: Request) { const connection = await getConnection("google-drive"); if (!connection) return Response.json({ error: "Google Drive is not connected" }, { status: 409 }); const url = new URL(request.url); const result = await listDriveFolders(connection.accessToken, url.searchParams.get("parentId") ?? "root", url.searchParams.get("pageToken") ?? undefined); return Response.json(result); }
export const GET = tenantHandler(get);
