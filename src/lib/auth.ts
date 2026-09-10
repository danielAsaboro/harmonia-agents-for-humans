import { createHash, randomBytes } from "node:crypto";
import {
  AuthorityError,
  cognitoPrincipal,
  requireWorkspaceAdministrator,
} from "./authority";
import { cognitoSettings, verifyCognitoIdentity } from "./cognito";
import { awsRepository, field, partition, recordKey } from "./dynamo";
import { db } from "./repository";
import {
  connectionEnvelopeKey,
  decryptSecret,
  encryptSecret,
  type SecretEnvelope,
} from "./secretEnvelope";
import { withTraceContext } from "./telemetry";
import {
  currentTenant,
  requireWorkspaceRole,
  runWithTenant,
  type TenantContext,
} from "./tenancy";

export const SESSION_COOKIE = "harmonia_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface UserDoc {
  defaultWorkspaceId: string;
  defaultBrandId: string;
}

function cookieValue(req: Request, name: string): string | null {
  const cookie = req.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function sessionCookie(value: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Max-Age=${SESSION_TTL_MS / 1000}; Path=/; HttpOnly${secure}; SameSite=Lax`;
}

async function ensurePersonalWorkspace(
  uid: string,
  email?: string,
): Promise<UserDoc> {
  const userRef = recordKey(partition("users").partition + "/" + uid);
  const existing = await awsRepository().read(userRef);
  if (existing.present) return existing.value as unknown as UserDoc;

  const workspaceId = stableId("ws", `${uid}:${randomBytes(16).toString("hex")}`);
  const brandId = stableId("brand", `${workspaceId}:default`);
  const now = new Date().toISOString();
  const user: UserDoc = {
    defaultWorkspaceId: workspaceId,
    defaultBrandId: brandId,
  };
  await db().atomic(async (tx) => {
    const fresh = await tx.read(userRef);
    if (fresh.present) return;
    const workspaceRef = recordKey(
      partition("workspaces").partition + "/" + workspaceId,
    );
    tx.insert(workspaceRef, {
      id: workspaceId,
      name: email ? `${email.split("@")[0]}'s workspace` : "My workspace",
      ownerUserId: uid,
      defaultBrandId: brandId,
      budget: {
        estimatedUsd: "0.00",
        observedUsd: "0.00",
        reservedUsd: "0.00",
        limitUsd: process.env.DEFAULT_WORKSPACE_BUDGET_USD ?? "100.00",
        approvalThresholdUsd:
          process.env.DEFAULT_JOB_APPROVAL_THRESHOLD_USD ?? "0.25",
      },
      createdAt: now,
      updatedAt: now,
    });
    tx.insert(
      recordKey(
        partition(workspaceRef.path + "/" + "members").partition + "/" + uid,
      ),
      {
        userId: uid,
        role: "owner",
        createdAt: now,
      },
    );
    tx.insert(
      recordKey(
        partition(workspaceRef.path + "/" + "brands").partition + "/" + brandId,
      ),
      {
        id: brandId,
        name: "Default brand",
        createdAt: now,
        updatedAt: now,
      },
    );
    tx.insert(userRef, user);
  });
  const resolved = await awsRepository().read(userRef);
  return resolved.value as unknown as UserDoc;
}

export async function requireTenantContext(
  req: Request,
): Promise<TenantContext> {
  const session = cookieValue(req, SESSION_COOKIE);
  if (!session) throw new AuthError("authentication required", 401);
  const sessionKey = recordKey(
    "sessions/" + createHash("sha256").update(session).digest("hex"),
  );
  const stored = await awsRepository().read(sessionKey);
  if (!stored.present || Number(stored.value?.expiresAt) <= Date.now())
    throw new AuthError("invalid session", 401);
  let idToken = String(stored.value?.idToken);
  if (
    Number(stored.value?.tokenExpiresAt) <= Date.now() &&
    stored.value?.refreshToken
  ) {
    const cfg = cognitoSettings();
    const refreshToken = decryptSecret(
      stored.value.refreshToken as SecretEnvelope,
      connectionEnvelopeKey(),
      sessionKey.path,
    );
    const response = await fetch(new URL("/oauth2/token", cfg.domain), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: cfg.clientId,
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new AuthError("session refresh failed", 401);
    const tokens = await response.json();
    const refreshed = await verifyCognitoIdentity(tokens.id_token);
    if (refreshed.uid !== stored.value.subjectId)
      throw new AuthError("session identity changed", 401);
    idToken = tokens.id_token;
    await awsRepository().atomic(async (tx) => {
      const current = await tx.read(sessionKey);
      if (!current.present) throw new AuthError("session was revoked", 401);
      if (current.value?.tokenExpiresAt !== stored.value?.tokenExpiresAt) {
        idToken = String(current.value?.idToken);
        return;
      }
      tx.patch(sessionKey, {
        idToken,
        tokenExpiresAt: refreshed.exp * 1000,
        ...(tokens.refresh_token
          ? {
              refreshToken: encryptSecret(
                tokens.refresh_token,
                connectionEnvelopeKey(),
                sessionKey.path,
              ),
            }
          : {}),
      });
    });
  }
  let decoded;
  try {
    decoded = await verifyCognitoIdentity(idToken);
  } catch {
    throw new AuthError("invalid session", 401);
  }
  const user = await ensurePersonalWorkspace(decoded.uid, decoded.email);
  const member = await awsRepository().read(
    recordKey(
      partition(
        recordKey(
          partition("workspaces").partition + "/" + user.defaultWorkspaceId,
        ).path +
          "/" +
          "members",
      ).partition +
        "/" +
        decoded.uid,
    ),
  );
  if (!member.present)
    throw new AuthError("workspace membership required", 403);
  let role;
  try {
    role = requireWorkspaceRole(field(member.value, "role"));
  } catch {
    throw new AuthError("invalid workspace membership", 403);
  }
  if (role === "service")
    throw new AuthError("invalid workspace membership", 403);
  return {
    workspaceId: user.defaultWorkspaceId,
    brandId: user.defaultBrandId,
    principal: cognitoPrincipal({
      subjectId: decoded.uid,
      workspaceRole: role,
      authenticationId: `cognito_${createHash("sha256").update(session).digest("hex").slice(0, 24)}`,
    }),
  };
}

export async function withTenant<T>(
  req: Request,
  work: (tenant: TenantContext) => T,
): Promise<T> {
  const tenant = await requireTenantContext(req);
  return withTraceContext(req.headers, () =>
    runWithTenant(tenant, () => work(tenant)),
  );
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}

export function authErrorResponse(error: unknown): Response {
  if (error instanceof AuthError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof AuthorityError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }
  throw error;
}

export function tenantHandler<Args extends unknown[]>(
  handler: (req: Request, ...args: Args) => Promise<Response>,
): (req: Request, ...args: Args) => Promise<Response> {
  return async (req, ...args) => {
    try {
      return await withTenant(req, () => handler(req, ...args));
    } catch (error) {
      return authErrorResponse(error);
    }
  };
}

/** Browser-session-only boundary for workspace control-plane mutations. */
export function administratorTenantHandler<Args extends unknown[]>(
  handler: (req: Request, ...args: Args) => Promise<Response>,
): (req: Request, ...args: Args) => Promise<Response> {
  return operatorTenantHandler(async (req, ...args) => {
    requireWorkspaceAdministrator(currentTenant());
    return handler(req, ...args);
  });
}

/** Browser-session-only tenant boundary for explicit operator effects. */
export function operatorTenantHandler<Args extends unknown[]>(
  handler: (req: Request, ...args: Args) => Promise<Response>,
): (req: Request, ...args: Args) => Promise<Response> {
  return async (req, ...args) => {
    try {
      return await withTenant(req, () => handler(req, ...args));
    } catch (error) {
      return authErrorResponse(error);
    }
  };
}

export async function createSessionCookie(
  idToken: string,
  refreshToken?: string,
): Promise<string> {
  const identity = await verifyCognitoIdentity(idToken);
  const value = randomBytes(32).toString("base64url");
  const key = recordKey(
    "sessions/" + createHash("sha256").update(value).digest("hex"),
  );
  await awsRepository().insert(key, {
    idToken,
    subjectId: identity.uid,
    tokenExpiresAt: identity.exp * 1000,
    expiresAt: refreshToken
      ? Date.now() + SESSION_TTL_MS
      : Math.min(identity.exp * 1000, Date.now() + SESSION_TTL_MS),
    ...(refreshToken
      ? {
          refreshToken: encryptSecret(
            refreshToken,
            connectionEnvelopeKey(),
            key.path,
          ),
        }
      : {}),
  });
  return sessionCookie(value);
}

export async function revokeSession(req: Request): Promise<void> {
  const value = cookieValue(req, SESSION_COOKIE);
  if (value)
    await awsRepository().remove(
      recordKey("sessions/" + createHash("sha256").update(value).digest("hex")),
    );
}

export function clearSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly${secure}; SameSite=Lax`;
}
