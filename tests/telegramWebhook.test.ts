import { describe, expect, it } from "vitest";

import {
  TelegramWebhookError,
  callbackNonce,
  decideTelegramNonceClaim,
  verifyTelegramWebhook,
} from "@/lib/telegramWebhook";

const route = {
  routeTokenDigest: "f".repeat(64),
  webhookSecretDigest: "a".repeat(64),
  chatIdDigest: "b".repeat(64),
  workspaceId: "workspace-1",
  brandId: "brand-1",
};

const update = {
  update_id: 10,
  callback_query: {
    id: "callback-1",
    from: { id: 42 },
    message: { chat: { id: -1001 } },
    data: "harmonia:nonce_abcdefghijklmnopqrstuvwxyz012345",
  },
};

describe("Telegram webhook authority", () => {
  it("rejects a structurally valid callback when the webhook secret is wrong", () => {
    expect(() => verifyTelegramWebhook({
      route: { ...route, webhookSecretDigest: route.webhookSecretDigest },
      routeToken: "route-token",
      secret: "wrong",
      update,
      digest: (value) => value === "route-token" ? route.routeTokenDigest : value === "correct" ? route.webhookSecretDigest : value === "-1001" ? route.chatIdDigest : "0".repeat(64),
    })).toThrowError(new TelegramWebhookError("invalid Telegram webhook secret", 401));
  });

  it("derives a Telegram principal from the callback sender and allow-listed chat", () => {
    const verified = verifyTelegramWebhook({
      route,
      routeToken: "route-token",
      secret: "correct",
      update,
      digest: (value) => value === "route-token" ? route.routeTokenDigest : value === "correct" ? route.webhookSecretDigest : value === "-1001" ? route.chatIdDigest : "c".repeat(64),
    });
    expect(verified.principal).toMatchObject({
      kind: "telegram_user",
      subjectId: `telegram_${"c".repeat(24)}`,
    });
    expect(verified.nonce).toBe(callbackNonce(update.callback_query.data));
  });

  it("strictly rejects extra callback fields", () => {
    expect(() => verifyTelegramWebhook({
      route,
      routeToken: "route-token",
      secret: "correct",
      update: { ...update, callback_query: { ...update.callback_query, game_short_name: "unexpected" } },
      digest: (value) => value === "route-token" ? route.routeTokenDigest : value === "correct" ? route.webhookSecretDigest : value === "-1001" ? route.chatIdDigest : "c".repeat(64),
    })).toThrow("invalid Telegram update");
  });

  it("returns the original decision for an already-consumed callback", () => {
    expect(decideTelegramNonceClaim({
      state: "consumed",
      expiresAt: "2026-08-27T00:00:00.000Z",
      decisionId: "job-1:approval:action-1",
    }, new Date("2026-08-26T00:00:00.000Z"))).toEqual({
      outcome: "duplicate",
      decisionId: "job-1:approval:action-1",
    });
  });
});
