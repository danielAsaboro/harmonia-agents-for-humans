import { describe, expect, it, vi } from "vitest";
import { configureTelegramWebhook, sendTelegramMessage } from "@/lib/telegramApi";

describe("Telegram official Bot API client", () => {
  it("configures the exact webhook URL and secret", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));
    await configureTelegramWebhook({
      botToken: "token", webhookUrl: "https://app.example/api/telegram/webhook/route", webhookSecret: "secret", request,
    });
    expect(request).toHaveBeenCalledWith(
      "https://api.telegram.org/bottoken/setWebhook",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ url: "https://app.example/api/telegram/webhook/route", secret_token: "secret", allowed_updates: ["message", "callback_query"] }) }),
    );
  });

  it("sends a reply to the allow-listed chat", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }));
    await sendTelegramMessage({ botToken: "token", chatId: "-1001", text: "Drafting.", request });
    expect(request).toHaveBeenCalledWith(
      "https://api.telegram.org/bottoken/sendMessage",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ chat_id: "-1001", text: "Drafting." }) }),
    );
  });
});
