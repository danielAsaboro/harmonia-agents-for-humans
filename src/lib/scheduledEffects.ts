import { requireContentOperator } from "./authority";
import { partition,recordKey,REMOVE_FIELD } from "./dynamo";
import { createEffectCommand,effectCommandDigest,invalidateEffectCommand,type EffectCommand,type EffectCommandInput } from "./effectCommands";
import { contentHash } from "./idempotency";
import { db } from "./repository";
import type { TenantContext } from "./tenancy";
import { tenantCollectionPath } from "./tenancy";
import type { ContentItem } from "./types";

export function buildScheduledEffectCommand(
  item: ContentItem,
  context: TenantContext,
  now = new Date().toISOString(),
): EffectCommand {
  const actor = requireContentOperator(context);
  if (!item.scheduledFor) throw new Error("scheduled content requires an execution time");
  if (item.platforms.length !== 1 || item.platforms[0] !== "x") {
    throw new Error("scheduled publishing currently requires exactly one supported platform");
  }
  const base = {
    id: "pending",
    workspaceId: context.workspaceId,
    brandId: context.brandId,
    sourceKind: "scheduled_content" as const,
    sourceId: item.id,
    jobId: item.jobId,
    actionId: `scheduled:${item.id}`,
    actionType: "publish_x_post" as const,
    payload: { text: item.text, platforms: [...item.platforms] },
    executeAfter: item.scheduledFor,
    now,
  };
  const provisional: EffectCommandInput = {
    ...base,
    authorization: { kind: "approval", approvalId: "pending", approvedPayloadDigest: "pending" },
  };
  const digest = effectCommandDigest(provisional);
  return createEffectCommand({
    ...base,
    id: `cmd_${contentHash(`${item.id}:${digest}`).slice(0, 40)}`,
    authorization: {
      kind: "approval",
      approvalId: `schedule:${item.id}:${actor.authenticationId}`,
      approvedPayloadDigest: digest,
    },
  });
}

export function planScheduledMutation(
  item: ContentItem,
  command: EffectCommand | null,
  patch: Partial<Pick<ContentItem, "text" | "platforms" | "publishMode" | "scheduledFor">>,
  now = new Date().toISOString(),
): { item: ContentItem; command: EffectCommand | null } {
  const next = { ...item, ...patch, updatedAt: now };
  const materialChanged = ["text", "platforms", "publishMode", "scheduledFor"].some((key) =>
    key in patch && JSON.stringify(item[key as keyof ContentItem]) !== JSON.stringify(next[key as keyof ContentItem]));
  if (!materialChanged) return { item: next, command };
  return {
    item: { ...next, status: "draft", publishMode: "approval" },
    command: command ? invalidateEffectCommand(command, "payload_changed", now) : null,
  };
}

export async function applyScheduledContentMutation(
  itemId: string,
  updates: Partial<ContentItem> & { scheduledFor?: string | null },
  context: TenantContext,
): Promise<{ item: ContentItem; command: EffectCommand | null }> {
  const itemRef = recordKey(partition(tenantCollectionPath(context, "content_items")).partition + "/" + itemId);
  return db().atomic(async (tx) => {
    const itemSnap = await tx.read(itemRef);
    if (!itemSnap.present) throw new Error("content item not found");
    const current = itemSnap.value as unknown as ContentItem;
    const commandRef = current.effectCommandId
      ? recordKey(partition(tenantCollectionPath(context, "effect_commands")).partition + "/" + current.effectCommandId)
      : null;
    const commandSnap = commandRef ? await tx.read(commandRef) : null;
    const existingCommand = commandSnap?.present ? commandSnap.value as unknown as EffectCommand : null;
    const normalizedUpdates = { ...updates };
    if (normalizedUpdates.scheduledFor === null) delete normalizedUpdates.scheduledFor;
    const planned = planScheduledMutation(current, existingCommand, normalizedUpdates);
    let next = planned.item;
    let nextCommand = planned.command;
    if (updates.scheduledFor === null) next = { ...next, scheduledFor: undefined };
    if (updates.status === "scheduled" && next.scheduledFor) {
      next = { ...next, status: "scheduled" };
      if (next.publishMode === "auto") {
        nextCommand = buildScheduledEffectCommand(next, context);
        next = { ...next, effectCommandId: nextCommand.id };
      } else {
        next = { ...next, effectCommandId: undefined };
      }
    } else if (planned.command?.state === "cancelled") {
      next = { ...next, effectCommandId: undefined };
    }
    if (existingCommand && planned.command?.state === "cancelled" && commandRef) tx.put(commandRef, planned.command);
    if (nextCommand?.state === "prepared" && nextCommand.id !== existingCommand?.id) {
      tx.insert(recordKey(partition(tenantCollectionPath(context, "effect_commands")).partition + "/" + nextCommand.id), nextCommand);
    }
    const stored = Object.fromEntries(Object.entries(next).map(([key, value]) => [
      key,
      value === undefined ? REMOVE_FIELD : value,
    ]));
    tx.put(itemRef, stored, { merge: true });
    return { item: next, command: nextCommand };
  });
}

export async function approveScheduledContent(
  itemId: string,
  context: TenantContext,
): Promise<{ item: ContentItem; command: EffectCommand }> {
  const itemRef = recordKey(partition(tenantCollectionPath(context, "content_items")).partition + "/" + itemId);
  return db().atomic(async (tx) => {
    const snap = await tx.read(itemRef);
    if (!snap.present) throw new Error("content item not found");
    const item = snap.value as unknown as ContentItem;
    if (item.status !== "awaiting_final_review") throw new Error(`item status is '${item.status}'`);
    const command = buildScheduledEffectCommand({ ...item, scheduledFor: new Date().toISOString() }, context);
    tx.insert(recordKey(partition(tenantCollectionPath(context, "effect_commands")).partition + "/" + command.id), command);
    const next = { ...item, status: "publishing" as const, effectCommandId: command.id, updatedAt: new Date().toISOString() };
    tx.patch(itemRef, { status: next.status, effectCommandId: command.id, updatedAt: next.updatedAt });
    return { item: next, command };
  });
}
