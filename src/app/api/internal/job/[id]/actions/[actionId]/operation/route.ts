import { mediaOperationSchema } from "@/lib/contracts";
import { getMediaOperation, saveMediaOperation } from "@/lib/firestore";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";

interface Params {
  params: Promise<{ id: string; actionId: string }>;
}

export async function GET(req: Request, { params }: Params) {
  if (!isInternalAuthorized(req)) return unauthorized();
  const { id, actionId } = await params;
  const operation = await getMediaOperation(id, actionId);
  if (!operation) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ operation });
}

export async function POST(req: Request, { params }: Params) {
  if (!isInternalAuthorized(req)) return unauthorized();
  const { id, actionId } = await params;
  const parsed = mediaOperationSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid payload" }, { status: 400 });
  try {
    const operation = await saveMediaOperation(
      id, actionId, parsed.data.provider, parsed.data.operationName,
    );
    return Response.json({ operation });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 409 },
    );
  }
}
