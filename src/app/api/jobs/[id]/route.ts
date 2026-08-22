import { getJob, listEvents, listReceipts } from "@/lib/firestore";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const job = await getJob(id);
  const [events, receipts] = await Promise.all([
    listEvents(id),
    listReceipts(id),
  ]);
  return Response.json({ job, events, receipts });
}
