import { getConfig } from "./config";
import { timingSafeEqual } from "./internalAuth";

/**
 * Mutating operator endpoints (job creation, approvals, retries) are gated by
 * a shared operator token when configured. Local development may run without
 * one; cloud deployments must set OPERATOR_TOKEN.
 */
export function isOperatorAuthorized(req: Request): boolean {
  const token = getConfig().OPERATOR_TOKEN;
  if (!token) return true;
  const header = req.headers.get("x-operator-token") ?? "";
  const a = Buffer.from(header);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function operatorForbidden(): Response {
  return Response.json(
    { error: "operator token required" },
    { status: 403 },
  );
}
