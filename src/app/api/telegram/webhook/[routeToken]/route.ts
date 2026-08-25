import {
  claimTelegramDecisionNonce,
  finalizeTelegramDecisionNonce,
  getTelegramWebhookRoute,
} from "@/lib/firestore";
import { resolveDecision } from "@/lib/decisions";
import { runWithTenant } from "@/lib/tenancy";
import { TelegramWebhookError, verifyTelegramWebhook } from "@/lib/telegramWebhook";

const MAX_UPDATE_BYTES = 64 * 1024;

function errorResponse(error: unknown): Response {
  if (error instanceof TelegramWebhookError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : String(error);
  const status = message.includes("not found") ? 404
    : message.includes("expired") || message.includes("processing") || message.includes("mismatch") ? 409
      : 400;
  return Response.json({ error: message }, { status });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ routeToken: string }> },
): Promise<Response> {
  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPDATE_BYTES) {
    return errorResponse(new TelegramWebhookError("Telegram update is too large", 413));
  }
  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_UPDATE_BYTES) {
    return errorResponse(new TelegramWebhookError("Telegram update is too large", 413));
  }
  const { routeToken } = await params;
  try {
    const route = await getTelegramWebhookRoute(routeToken);
    if (!route) throw new TelegramWebhookError("Telegram webhook route not found", 404);
    const verified = verifyTelegramWebhook({
      route,
      routeToken,
      secret: req.headers.get("x-telegram-bot-api-secret-token") ?? "",
      update: JSON.parse(raw) as unknown,
    });
    const claim = await claimTelegramDecisionNonce(routeToken, verified.nonce);
    if (claim.nonce.workspaceId !== route.workspaceId || claim.nonce.brandId !== route.brandId) {
      throw new TelegramWebhookError("Telegram decision tenant mismatch", 409);
    }
    if (claim.duplicate) {
      return Response.json({ ok: true, duplicate: true, decisionId: claim.nonce.decisionId });
    }
    const outcome = await runWithTenant({
      workspaceId: route.workspaceId,
      brandId: route.brandId,
      principal: verified.principal,
    }, () => resolveDecision(
      claim.nonce.jobId,
      claim.nonce.actionId,
      claim.nonce.decision,
      claim.nonce.payloadDigest,
    ));
    const decisionId = `${claim.nonce.jobId}:approval:${claim.nonce.actionId}`;
    await finalizeTelegramDecisionNonce(routeToken, verified.nonce, decisionId);
    return Response.json({ ok: true, duplicate: false, decisionId, outcome });
  } catch (error) {
    return errorResponse(error);
  }
}
