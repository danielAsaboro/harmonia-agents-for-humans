import { clearSessionCookie, revokeSession } from "@/lib/auth";
export async function DELETE(req: Request) {
  const origin = req.headers.get("origin");
  if (origin !== new URL(req.url).origin)
    return Response.json({ error: "invalid origin" }, { status: 403 });
  await revokeSession(req);
  return Response.json(
    { ok: true },
    {
      headers: {
        "set-cookie": clearSessionCookie(),
        "cache-control": "no-store",
      },
    },
  );
}
