import { z } from "zod";
import { operatorTenantHandler } from "@/lib/auth";
import { claimCalendarProvisioning, completeCalendarProvisioning, getConnection, getContentItem, markCalendarProvisioningUncertain, saveCalendarSyncIfUnchanged, saveConnection, updateContentItem } from "@/lib/firestore";
import { currentTenant } from "@/lib/tenancy";
import { getPlatform, refreshAccessToken } from "@/lib/oauth";
import { calendarSyncFailure } from "@/lib/calendarSyncState";
import { ensureHarmoniaCalendar, executeCalendarMutation, GoogleCalendarApi } from "@/lib/googleCalendar";

const requestSchema = z.object({ itemId: z.string().min(1), operation: z.enum(["sync", "remove"]) });

async function validConnection() {
  const connection = await getConnection("google-calendar");
  if (!connection) throw new Error("Google Calendar is not connected");
  if (!connection.expiresAt || Date.parse(connection.expiresAt) > Date.now() + 60_000) return connection;
  if (!connection.refreshToken) throw new Error("Google Calendar authorization expired; reconnect it");
  const def = getPlatform("google-calendar");
  if (!def) throw new Error("Google Calendar OAuth is not configured");
  const tokens = await refreshAccessToken(def, connection.refreshToken);
  const refreshed = { ...connection, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? connection.refreshToken, expiresAt: tokens.expiresInSeconds ? new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString() : connection.expiresAt };
  await saveConnection(refreshed);
  return refreshed;
}

async function get() {
  const connection = await getConnection("google-calendar");
  const expired = connection?.expiresAt ? Date.parse(connection.expiresAt) <= Date.now() : false;
  return Response.json({
    connected: Boolean(connection) && !expired,
    reauthorizationRequired: Boolean(connection) && expired,
    calendarId: connection?.calendarId,
    calendarTitle: connection?.calendarTitle,
    connectedAt: connection?.connectedAt,
  });
}

async function post(req: Request) {
  const parsed = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid calendar synchronization request" }, { status: 400 });
  const item = await getContentItem(parsed.data.itemId);
  if (!item) return Response.json({ error: "content item not found" }, { status: 404 });
  if (parsed.data.operation === "sync" && (!item.scheduledFor || !["scheduled", "awaiting_final_review"].includes(item.status))) {
    return Response.json({ error: "only scheduled content can be synchronized" }, { status: 409 });
  }
  const now = new Date().toISOString();
  try {
    const connection = await validConnection();
    const gateway = new GoogleCalendarApi(connection.accessToken);
    let calendar;
    if (connection.calendarId) {
      calendar = await ensureHarmoniaCalendar(gateway, connection.calendarId);
    } else {
      const claim = await claimCalendarProvisioning();
      if (claim.calendarId) {
        calendar = await ensureHarmoniaCalendar(gateway, claim.calendarId);
      } else {
        try {
          calendar = await ensureHarmoniaCalendar(gateway);
          await completeCalendarProvisioning(claim.claimId!, calendar);
        } catch (error) {
          await markCalendarProvisioningUncertain(claim.claimId!);
          throw error;
        }
      }
    }
    const tenant = currentTenant();
    const sync = await executeCalendarMutation({ operation: parsed.data.operation, item, workspaceId: tenant.workspaceId, brandId: tenant.brandId, calendarId: calendar.id, now }, gateway);
    const persisted = await saveCalendarSyncIfUnchanged(item.id, item.updatedAt, sync);
    return Response.json({ ok: true, sync: persisted });
  } catch (error) {
    const sync = calendarSyncFailure(item, now, error);
    await updateContentItem(item.id, { googleCalendarSync: sync });
    return Response.json({ error: error instanceof Error ? error.message : "Google Calendar synchronization failed", sync }, { status: 502 });
  }
}

export const GET = operatorTenantHandler(get);
export const POST = operatorTenantHandler(post);
