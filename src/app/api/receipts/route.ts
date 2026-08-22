import { listRecentReceipts } from "@/lib/firestore";

export async function GET(req: Request) {
  const outcome = new URL(req.url).searchParams.getAll("outcome").filter(Boolean);
  let receipts = await listRecentReceipts();
  if (outcome.length) receipts = receipts.filter((r) => outcome.includes(r.outcome));
  return Response.json({ receipts });
}
