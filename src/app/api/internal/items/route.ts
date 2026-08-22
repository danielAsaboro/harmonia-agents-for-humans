import { z } from "zod";
import {
  createNotification,
  getContentItem,
  listContentItems,
  updateContentItem,
} from "@/lib/firestore";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";

/**
 * Worker scheduler feed: items whose scheduled time has arrived.
 * Auto-mode items are handed over for immediate publishing; approval-mode
 * items flip to awaiting_final_review and fire a notification instead.
 */
export async function GET(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  const now = Date.now();
  const items = await listContentItems();
  const due: Array<{ id: string; text: string; platforms: string[]; publishMode: string; jobId: string }> = [];
  for (const item of items) {
    if (item.status !== "scheduled" || !item.scheduledFor) continue;
    if (Date.parse(item.scheduledFor) > now) continue;
    if (item.publishMode === "approval") {
      await updateContentItem(item.id, { status: "awaiting_final_review" });
      await createNotification({
        kind: "final_review_needed",
        title: "Final review needed",
        body: `"${item.text.slice(0, 80)}" is due for ${item.platforms.join(", ")}. Approve to publish.`,
        severity: "warning",
        refType: "content_item",
        refId: item.id,
        href: "/dashboard/calendar",
        createdAt: new Date().toISOString(),
      });
      continue;
    }
    due.push({ id: item.id, text: item.text, platforms: item.platforms, publishMode: item.publishMode, jobId: item.jobId });
  }
  const publishing = items
    .filter((i) => i.status === "publishing")
    .map((i) => ({ id: i.id, text: i.text, platforms: i.platforms, publishMode: i.publishMode, jobId: i.jobId }));
  return Response.json({ due, publishing });
}

const updateSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["published", "failed", "publishing"]),
  publishedPostId: z.string().optional(),
  publishedUrl: z.string().optional(),
  failureReason: z.string().max(500).optional(),
});

/** Worker reports publish outcomes for a content item. */
export async function POST(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  const body = await req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid update" }, { status: 400 });
  }
  const { id, status, publishedPostId, publishedUrl, failureReason } = parsed.data;
  const item = await getContentItem(id);
  if (!item) return Response.json({ error: "item not found" }, { status: 404 });

  await updateContentItem(id, {
    status,
    ...(status === "published"
      ? {
          publishedPostId,
          publishedUrl,
          publishedAt: new Date().toISOString(),
          failureReason: undefined as unknown as string,
        }
      : {}),
    ...(status === "failed" ? { failureReason } : {}),
  });

  if (status === "published") {
    await createNotification({
      kind: "item_published",
      title: "Post published",
      body: `"${item.text.slice(0, 80)}" went live on ${item.platforms.join(", ")}.`,
      severity: "info",
      refType: "content_item",
      refId: id,
      href: "/dashboard/calendar",
      createdAt: new Date().toISOString(),
    });
  } else if (status === "failed") {
    await createNotification({
      kind: "item_publish_failed",
      title: "Scheduled post failed",
      body: `"${item.text.slice(0, 80)}" failed: ${failureReason ?? "unknown error"}`,
      severity: "critical",
      refType: "content_item",
      refId: id,
      href: "/dashboard/calendar",
      createdAt: new Date().toISOString(),
    });
  }
  return Response.json({ ok: true });
}
