import { randomBytes, createHash } from "node:crypto";
import { cognitoSettings } from "@/lib/cognito";
export async function GET() {
  const cfg = cognitoSettings(),
    state = randomBytes(32).toString("base64url"),
    verifier = randomBytes(32).toString("base64url"),
    nonce = randomBytes(32).toString("base64url");
  const url = new URL("/oauth2/authorize", cfg.domain);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: "openid email profile",
    identity_provider: "Google",
    state,
    nonce,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return new Response(null, {
    status: 302,
    headers: {
      location: url.toString(),
      "set-cookie": `harmonia_oauth=${Buffer.from(JSON.stringify({ state, verifier, nonce })).toString("base64url")}; Max-Age=600; Path=/api/auth; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
      "cache-control": "no-store",
    },
  });
}
