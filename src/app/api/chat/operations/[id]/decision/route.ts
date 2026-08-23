import { z } from "zod";
import { tenantHandler } from "@/lib/auth";
import { decidePendingOperation } from "@/lib/pendingOperations";

const decisionSchema = z.object({ decision: z.enum(["approved", "rejected"]) }).strict();

async function post(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = decisionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid operation decision" }, { status: 400 });
  try {
    const operation = await decidePendingOperation(id, parsed.data.decision);
    return Response.json({ operation });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("not found") ? 404 : message.includes("expired") || message.includes("already") ? 409 : 400;
    return Response.json({ error: message }, { status });
  }
}

export const POST = tenantHandler(post);
