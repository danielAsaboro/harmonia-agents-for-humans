import { CognitoJwtVerifier } from "aws-jwt-verify";
export function cognitoSettings() {
  const pool = process.env.COGNITO_USER_POOL_ID,
    clientId = process.env.COGNITO_CLIENT_ID,
    domain = process.env.COGNITO_DOMAIN,
    redirectUri = process.env.AUTH_REDIRECT_URI;
  if (!pool || !clientId || !domain || !redirectUri)
    throw new Error("Cognito is not configured");
  const issuer = new URL(
    domain.startsWith("https://") ? domain : `https://${domain}`,
  );
  if (issuer.protocol !== "https:")
    throw new Error("Cognito domain must use HTTPS");
  return { pool, clientId, domain: issuer.origin, redirectUri };
}
export async function verifyCognitoIdentity(token: string) {
  const cfg = cognitoSettings();
  const payload = await CognitoJwtVerifier.create({
    userPoolId: cfg.pool,
    clientId: cfg.clientId,
    tokenUse: "id",
  }).verify(token);
  const identities =
    typeof payload.identities === "string"
      ? JSON.parse(payload.identities)
      : payload.identities;
  if (
    !Array.isArray(identities) ||
    !identities.some(
      (v: { providerName?: string }) => v.providerName === "Google",
    )
  )
    throw new Error("Google federation required");
  return {
    ...payload,
    nonce: (payload as Record<string, unknown>).nonce,
    uid: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
  };
}
