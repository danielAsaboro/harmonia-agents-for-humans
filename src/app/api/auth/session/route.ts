import { clearSessionCookie, createSessionCookie } from "@/lib/auth";
import { z } from "zod";

const schema = z.object({ idToken: z.string().min(100) });

export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid identity token" }, { status: 400 });
  try {
    const cookie = await createSessionCookie(parsed.data.idToken);
    return Response.json({ ok: true }, { headers: { "set-cookie": cookie } });
  } catch {
    return Response.json({ error: "authentication failed" }, { status: 401 });
  }
}

export async function DELETE() {
  return Response.json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
}
