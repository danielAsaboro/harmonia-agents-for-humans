import { listReceipts } from "@/lib/firestore";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isInternalAuthorized(req)) return unauthorized();
  const { id } = await params;
  const receipts = await listReceipts(id);
  return Response.json({ receipts });
}
