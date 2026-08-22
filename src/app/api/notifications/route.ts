import { listNotifications, markAllNotificationsRead, markNotificationRead } from "@/lib/firestore";

export async function GET() {
  const notifications = await listNotifications();
  const unread = notifications.filter((n) => !n.readAt).length;
  return Response.json({ notifications, unread });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  if (body?.action === "read-all") {
    await markAllNotificationsRead();
    return Response.json({ ok: true });
  }
  if (typeof body?.id === "string" && body?.action === "read") {
    await markNotificationRead(body.id);
    return Response.json({ ok: true });
  }
  return Response.json({ error: "expected {action:'read',id} or {action:'read-all'}" }, { status: 400 });
}
