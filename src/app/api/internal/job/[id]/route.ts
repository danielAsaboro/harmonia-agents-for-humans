import { getJob } from "@/lib/firestore";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isInternalAuthorized(req)) return unauthorized();
  const { id } = await params;
  const job = await getJob(id);
  return Response.json({ job });
}
