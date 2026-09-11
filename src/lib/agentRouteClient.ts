import { z } from "zod";

import { getConfig } from "@/lib/config";
import { strategyContextSchema } from "@/lib/contracts";
import { currentTenant, tenantSubjectId } from "@/lib/tenancy";
import type { WorkspaceContentContext } from "@/lib/workspaceContentContext";
import { workPlacementSchema, intakeMissingFieldSchema, type IntakeAdvice } from "./intake/contracts";

const outputConcept = z.enum([
  "short_social_post", "social_thread", "professional_post", "article", "newsletter",
  "caption", "carousel", "social_image", "quote_card", "diagram", "short_video",
  "generated_video", "generated_music", "calendar", "content_package",
]);
const socialPlatform = z.enum(["x", "linkedin", "linkedin-organization", "instagram", "tiktok"]);
const routedStrategyContextSchema = strategyContextSchema.extend({
  researchRequest: strategyContextSchema.shape.researchRequest.unwrap().nullable().optional(),
}).transform(({ researchRequest, ...context }) => ({
  ...context,
  ...(researchRequest ? { researchRequest } : {}),
}));
const routeSchema = z.object({
  workPlacement: workPlacementSchema.nullable(),
  targetName: z.string().max(200).nullable(),
  intent: z.enum(["establish_strategy", "revise_strategy", "advance_plan", "manage_calendar", "append_deliverable", "repurpose_source", "one_off_content", "status_evidence", "effect_request", "conversation"]),
  userOutcome: z.string().min(1).max(500), sourceUrls: z.array(z.string().url()).max(10),
  outputConcepts: z.array(outputConcept).max(8), assumptions: z.array(z.string()).max(8),
  platformRecommendations: z.array(socialPlatform).max(5), connectionSuggestions: z.array(socialPlatform).max(5),
  missingField: intakeMissingFieldSchema.nullable(), resolvedField: intakeMissingFieldSchema.nullable(),
  needsClarification: z.boolean(), clarifyingQuestion: z.string().max(300).nullable(),
  requiresRightsAttestation: z.boolean(), effectRequested: z.boolean(),
  effectAuthorized: z.literal(false), jobId: z.string().max(128).nullable(),
  deliverableName: z.string().min(1).max(500).nullable().default(null),
  scheduledFor: z.string().max(100).nullable().default(null),
  dependencyItemIds: z.array(z.string().min(1).max(200)).max(32).default([]),
  requiredAssetIds: z.array(z.string().min(1).max(200)).max(32).default([]),
  strategyContext: routedStrategyContextSchema.nullable(),
}).superRefine((value, ctx) => {
  if (value.effectRequested !== (value.intent === "effect_request")) ctx.addIssue({ code: "custom", message: "effect request mismatch" });
  if (value.needsClarification !== Boolean(value.clarifyingQuestion) || value.needsClarification !== Boolean(value.missingField)) ctx.addIssue({ code: "custom", message: "clarification mismatch" });
  if (value.connectionSuggestions.some((platform) => !value.platformRecommendations.includes(platform))) ctx.addIssue({ code: "custom", message: "connection suggestion mismatch" });
  if (value.intent === "append_deliverable" && !value.needsClarification) {
    if (value.workPlacement !== "existing_plan_item" || !value.targetName || !value.deliverableName || !value.scheduledFor || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value.scheduledFor) || !Number.isFinite(Date.parse(value.scheduledFor)) || value.outputConcepts.length === 0) {
      ctx.addIssue({ code: "custom", message: "complete append deliverable constraints required" });
    }
  }
  if (["establish_strategy", "revise_strategy"].includes(value.intent) && !value.needsClarification && !value.strategyContext) ctx.addIssue({ code: "custom", message: "strategy context is required before starting a strategy job" });
});

export type IntentRoute = z.infer<typeof routeSchema>;
export interface IntentRouteRequest { pendingSourceUrls?: string[]; pendingClarification?: IntakeAdvice["clarification"]; message: string; workspaceContext: WorkspaceContentContext; attachmentCount: number; recentConversation: Array<{ role: "user" | "assistant"; text: string }> }
interface Options { baseUrl?: string; token?: string; fetchImpl?: typeof fetch; timeoutMs?: number; tenant?: { workspaceId: string; brandId: string; userId: string } }

function safeValidationSummary(body: unknown): string {
  if (!body || typeof body !== "object" || !("detail" in body)) return "";
  const detail = body.detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const value = detail as { code?: unknown; message?: unknown };
    if (typeof value.code === "string" && /^[a-z0-9_]{1,80}$/.test(value.code) && typeof value.message === "string" && value.message.length > 0 && value.message.length <= 240) {
      return `: [${value.code}] ${value.message}`;
    }
    return "";
  }
  if (!Array.isArray(detail)) return "";
  const items = detail.flatMap((issue) => {
    if (!issue || typeof issue !== "object") return [];
    const value = issue as { loc?: unknown; type?: unknown };
    if (!Array.isArray(value.loc) || typeof value.type !== "string") return [];
    const location = value.loc.filter((part): part is string | number => typeof part === "string" || typeof part === "number").join(".");
    return location ? [`${location} (${value.type})`] : [];
  });
  return items.length ? `: ${items.slice(0, 4).join(", ")}` : "";
}

async function authorizedFetch(url: string, init: RequestInit, custom?: typeof fetch): Promise<Response> {
  if (custom) return custom(url, init);
  const headers = new Headers(init.headers);
  const token = headers.get("x-harmonia-internal-token");
  if (!token) throw new Error("internal authentication is not configured");
  headers.set("authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

export async function requestIntentRoute(input: IntentRouteRequest, options: Options = {}): Promise<IntentRoute> {
  const config = options.baseUrl && options.token ? null : getConfig();
  const baseUrl = new URL(options.baseUrl ?? config?.AGENT_SERVICE_URL ?? "").toString().replace(/\/$/, "");
  const tenant = options.tenant ?? (() => { const value = currentTenant(); return { workspaceId: value.workspaceId, brandId: value.brandId, userId: tenantSubjectId(value) }; })();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 180_000);
  try {
    const response = await authorizedFetch(`${baseUrl}/internal/agent/route`, {
      method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", "x-harmonia-internal-token": options.token ?? config?.INTERNAL_API_TOKEN ?? "", "x-workspace-id": tenant.workspaceId, "x-brand-id": tenant.brandId, "x-user-id": tenant.userId },
      body: JSON.stringify(input),
    }, options.fetchImpl);
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Harmonia intent routing failed (${response.status})${safeValidationSummary(body)}`);
    const parsed = routeSchema.safeParse(body);
    if (!parsed.success) throw new Error(`invalid intent route: ${parsed.error.issues[0]?.message ?? "contract mismatch"}`);
    return parsed.data;
  } finally { clearTimeout(timer); }
}

export const OUTPUT_CONCEPT_TO_KIND = {
  short_social_post: "x_post", social_thread: "x_thread", professional_post: "linkedin_post",
  article: "blog_article", newsletter: "newsletter", caption: "caption", carousel: "carousel_spec",
  social_image: "social_image", quote_card: "quote_card", diagram: "diagram", short_video: "short_clip",
  generated_video: "generated_video", generated_music: "generated_music",
  calendar: "editorial_calendar", content_package: "content_pack",
} as const;
