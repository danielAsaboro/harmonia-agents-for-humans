import { z } from "zod";
import { deleteConnection, saveConnection } from "@/lib/firestore";
import { isOperatorAuthorized, operatorForbidden } from "@/lib/operatorAuth";
import { getPlatform } from "@/lib/oauth";

const manualTokenSchema = z.object({
  accessToken: z.string().min(8),
  refreshToken: z.string().optional(),
  expiresInSeconds: z.number().int().positive().optional(),
  handle: z.string().max(120).optional(),
});

/** Advanced fallback: register an existing access token for a platform. */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ platform: string }> },
) {
  if (!isOperatorAuthorized(req)) return operatorForbidden();
  const { platform } = await params;
  if (!getPlatform(platform)) {
    return Response.json({ error: "unknown platform" }, { status: 404 });
  }
  const body = await req.json().catch(() => null);
  const parsed = manualTokenSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid token payload" }, { status: 400 });
  }
  await saveConnection({
    platform,
    mode: "manual",
    handle: parsed.data.handle,
    scopes: undefined,
    accessToken: parsed.data.accessToken,
    refreshToken: parsed.data.refreshToken,
    expiresAt: parsed.data.expiresInSeconds
      ? new Date(Date.now() + parsed.data.expiresInSeconds * 1000).toISOString()
      : undefined,
    connectedAt: new Date().toISOString(),
  });
  return Response.json({ ok: true });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ platform: string }> },
) {
  if (!isOperatorAuthorized(req)) return operatorForbidden();
  const { platform } = await params;
  if (!getPlatform(platform)) {
    return Response.json({ error: "unknown platform" }, { status: 404 });
  }
  await deleteConnection(platform);
  return Response.json({ ok: true });
}
