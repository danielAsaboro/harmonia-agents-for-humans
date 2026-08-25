import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { telegramPrincipal, type Principal } from "./authority";

export interface TelegramWebhookRoute {
  routeTokenDigest: string;
  webhookSecretDigest: string;
  chatIdDigest: string;
  workspaceId: string;
  brandId: string;
}

const callbackData = z.string().regex(/^harmonia:[A-Za-z0-9_-]{24,48}$/).max(64);
export const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  callback_query: z.object({
    id: z.string().min(1).max(256),
    from: z.object({ id: z.number().int() }).strict(),
    message: z.object({
      chat: z.object({ id: z.number().int() }).strict(),
    }).strict(),
    data: callbackData,
  }).strict(),
}).strict();

export class TelegramWebhookError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 403 | 404 | 409 | 413) {
    super(message);
  }
}

export function telegramDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function equalDigest(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function callbackNonce(data: string): string {
  const parsed = callbackData.safeParse(data);
  if (!parsed.success) throw new TelegramWebhookError("invalid Telegram callback data", 400);
  return parsed.data.slice("harmonia:".length);
}

export function decideTelegramNonceClaim(
  value: { state: "pending" | "processing" | "consumed"; expiresAt: string; claimedAt?: string; decisionId?: string },
  now = new Date(),
): { outcome: "claim" } | { outcome: "duplicate"; decisionId: string } {
  if (Date.parse(value.expiresAt) <= now.getTime()) {
    throw new TelegramWebhookError("Telegram decision nonce expired", 409);
  }
  if (value.state === "consumed") {
    if (!value.decisionId) throw new TelegramWebhookError("consumed Telegram nonce has no decision", 409);
    return { outcome: "duplicate", decisionId: value.decisionId };
  }
  if (value.state === "processing" && value.claimedAt && now.getTime() - Date.parse(value.claimedAt) < 60_000) {
    throw new TelegramWebhookError("Telegram decision nonce is already processing", 409);
  }
  return { outcome: "claim" };
}

export function verifyTelegramWebhook(input: {
  route: TelegramWebhookRoute;
  routeToken: string;
  secret: string;
  update: unknown;
  digest?: (value: string) => string;
}): {
  principal: Extract<Principal, { kind: "telegram_user" }>;
  nonce: string;
  updateId: number;
} {
  const digest = input.digest ?? telegramDigest;
  if (!equalDigest(digest(input.routeToken), input.route.routeTokenDigest)) {
    throw new TelegramWebhookError("Telegram webhook route not found", 404);
  }
  if (!equalDigest(digest(input.secret), input.route.webhookSecretDigest)) {
    throw new TelegramWebhookError("invalid Telegram webhook secret", 401);
  }
  const parsed = telegramUpdateSchema.safeParse(input.update);
  if (!parsed.success) throw new TelegramWebhookError("invalid Telegram update", 400);
  const query = parsed.data.callback_query;
  const chatIdDigest = digest(String(query.message.chat.id));
  if (!equalDigest(chatIdDigest, input.route.chatIdDigest)) {
    throw new TelegramWebhookError("Telegram chat is not allowed", 403);
  }
  const senderDigest = digest(String(query.from.id));
  const callbackQueryIdDigest = digest(query.id);
  return {
    principal: telegramPrincipal({
      subjectId: `telegram_${senderDigest.slice(0, 24)}`,
      authenticationId: `telegram_update_${parsed.data.update_id}`,
      chatIdDigest,
      callbackQueryIdDigest,
    }),
    nonce: callbackNonce(query.data),
    updateId: parsed.data.update_id,
  };
}
