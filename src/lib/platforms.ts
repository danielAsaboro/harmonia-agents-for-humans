/**
 * Social platform registry — one definition per supported network.
 * Connection status is derived from server-side environment configuration,
 * so the UI never claims a connection that isn't actually wired up.
 */
export type PlatformCapability = "publish" | "verify" | "metrics";

export interface PlatformDef {
  id: string;
  label: string;
  /** Env vars that must be set for this platform to be connectable. */
  requiredEnv: string[];
  /** Env vars that must be set for an active connection (subset of required). */
  activeEnv: string[];
  capabilities: PlatformCapability[];
  docsUrl: string;
  note: string;
}

export const PLATFORMS: PlatformDef[] = [
  {
    id: "x",
    label: "X (Twitter)",
    requiredEnv: ["X_BEARER_TOKEN"],
    activeEnv: ["X_BEARER_TOKEN"],
    capabilities: ["publish", "verify", "metrics"],
    docsUrl: "https://developer.x.com/en/portal/dashboard",
    note: "Publishes via official X API v2. Posting requires a project with Read & Write access; metrics use public_metrics.",
  },
  {
    id: "tiktok",
    label: "TikTok",
    requiredEnv: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
    activeEnv: ["TIKTOK_ACCESS_TOKEN"],
    capabilities: ["publish", "verify"],
    docsUrl: "https://developers.tiktok.com/doc/content-posting-api-get-started",
    note: "Direct Post via Content Posting API requires an approved app + unaudited/posting permissions. AIC labels apply to AI-generated content.",
  },
  {
    id: "instagram",
    label: "Instagram",
    requiredEnv: ["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"],
    activeEnv: ["INSTAGRAM_ACCESS_TOKEN"],
    capabilities: ["publish", "verify"],
    docsUrl: "https://developers.facebook.com/docs/instagram-api/getting-started",
    note: "Reels/posts via Instagram Graph API — requires a Professional (Business/Creator) account linked to a Facebook Page.",
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    requiredEnv: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
    activeEnv: ["LINKEDIN_ACCESS_TOKEN"],
    capabilities: ["publish", "verify", "metrics"],
    docsUrl: "https://learn.microsoft.com/en-us/linkedin/marketing/",
    note: "Posts via LinkedIn API (w_member_social or w_organization_social scopes). OAuth 2.0 three-legged flow.",
  },
  {
    id: "facebook",
    label: "Facebook Pages",
    requiredEnv: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"],
    activeEnv: ["FACEBOOK_PAGE_TOKEN"],
    capabilities: ["publish", "verify", "metrics"],
    docsUrl: "https://developers.facebook.com/docs/pages-api",
    note: "Page posts via Pages API with pages_manage_posts permission and a Page access token.",
  },
  {
    id: "youtube",
    label: "YouTube",
    requiredEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    activeEnv: ["YOUTUBE_REFRESH_TOKEN"],
    capabilities: ["publish", "verify", "metrics"],
    docsUrl: "https://developers.google.com/youtube/v3/guides/auth/installed-apps",
    note: "Uploads via YouTube Data API v3 (youtube.upload scope). Also enriches ingest metadata.",
  },
];

export function platformStatus(def: PlatformDef): {
  status: "connected" | "connectable" | "credentials_needed";
  missingActive: string[];
  missingRequired: string[];
} {
  const has = (name: string) => Boolean(process.env[name]);
  const missingRequired = def.requiredEnv.filter((e) => !has(e));
  const missingActive = def.activeEnv.filter((e) => !has(e));
  if (missingActive.length === 0 && missingRequired.length === 0) {
    return { status: "connected", missingActive, missingRequired };
  }
  if (missingRequired.length === 0) {
    // App credentials exist; an OAuth handshake would mint the access token.
    return { status: "connectable", missingActive, missingRequired };
  }
  return { status: "credentials_needed", missingActive, missingRequired };
}
