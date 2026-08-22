import { listProposals } from "@/lib/firestore";

/** All proactive proposals (newest first) for the dashboard inbox. */
export async function GET() {
  return Response.json({ proposals: await listProposals() });
}
