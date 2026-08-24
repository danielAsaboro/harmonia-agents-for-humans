import type { ContentItem } from "./types";

const MATERIAL_FIELDS = new Set(["text", "scheduledFor", "platforms", "status"]);

export function markCalendarSyncStale(item: ContentItem, patch: Partial<ContentItem>): ContentItem {
  if (!item.googleCalendarSync || item.googleCalendarSync.status !== "synced") return { ...item, ...patch };
  const changed = Object.entries(patch).some(([key, value]) =>
    MATERIAL_FIELDS.has(key) && JSON.stringify(value) !== JSON.stringify(item[key as keyof ContentItem]),
  );
  return {
    ...item,
    ...patch,
    googleCalendarSync: changed
      ? { ...item.googleCalendarSync, status: "update_required" }
      : item.googleCalendarSync,
  };
}
