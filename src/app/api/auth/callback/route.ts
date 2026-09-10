import { cognitoSettings, verifyCognitoIdentity } from "@/lib/cognito";
import { createSessionCookie } from "@/lib/auth";
export async function GET(req: Request) {
  try {
    const cfg = cognitoSettings(),
      url = new URL(req.url),
      code = url.searchParams.get("code"),
      state = url.searchParams.get("state");
    const cookie = (req.headers.get("cookie") ?? "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("harmonia_oauth="))
      ?.slice("harmonia_oauth=".length);
    if (!cookie || !code || !state) throw new Error("missing OAuth state");
    const flow = JSON.parse(Buffer.from(cookie, "base64url").toString("utf8"));
    if (flow.state !== state) throw new Error("OAuth state mismatch");
    const result = await fetch(new URL("/oauth2/token", cfg.domain), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: cfg.clientId,
        redirect_uri: cfg.redirectUri,
        code,
        code_verifier: flow.verifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!result.ok) throw new Error("OAuth exchange failed");
    const tokens = await result.json(),
      identity = await verifyCognitoIdentity(tokens.id_token);
    if (identity.nonce !== flow.nonce) throw new Error("OAuth nonce mismatch");
    const headers = new Headers({
      location: "/dashboard",
      "cache-control": "no-store",
    });
    headers.append("set-cookie", await createSessionCookie(tokens.id_token, tokens.refresh_token));
    headers.append(
      "set-cookie",
      "harmonia_oauth=; Max-Age=0; Path=/api/auth; HttpOnly; SameSite=Lax",
    );
    return new Response(null, { status: 302, headers });
  } catch {
    return new Response(null, {status:302,headers:{location:"/login?error=sign_in_failed","cache-control":"no-store","set-cookie":"harmonia_oauth=; Max-Age=0; Path=/api/auth; HttpOnly; SameSite=Lax"}});
  }
}
