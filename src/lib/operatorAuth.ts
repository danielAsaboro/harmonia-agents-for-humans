import { getConfig } from "./config";
import { timingSafeEqual } from "./internalAuth";

/**
 * Mutating operator endpoints (job creation, approvals, retries) are gated by
 * a shared operator token when configured. Local development may run without
 * one; cloud deployments must set OPERATOR_TOKEN. Browser navigations (OAuth
 * start) cannot send headers, so the token is also accepted as ?token=.
 */
export function isOperatorAuthorized(req: Request): boolean {
  const token = getConfig().OPERATOR_TOKEN;
  if (!token) return true;
  const header = req.headers.get("x-operator-token") ?? "";
  const query = new URL(req.url).searchParams.get("token") ?? "";
  for (const candidate of [header, query]) {
    if (!candidate) continue;
    const a = Buffer.from(candidate);
    const b = Buffer.from(token);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

export function operatorForbidden(): Response {
  return Response.json(
    { error: "operator token required" },
    { status: 403 },
  );
}
