import type { OutputKind } from "./types";
import { outputKindSchema } from "./contracts";
import { OUTPUT_CAPABILITIES } from "./outputCapabilities";
import { OUTPUT_CONCEPT_TO_KIND, requestIntentRoute } from "./agentRouteClient";
import { loadWorkspaceContentContext, type WorkspaceContentContext } from "./workspaceContentContext";

const URL_RE = /https?:\/\/[^\s<>"]+/gi;
const YOUTUBE_RE = /(?:youtube\.com\/(?:watch\?\S*v=|shorts\/)|youtu\.be\/)/i;

function extractJobId(message: string): string | undefined {
  for (const pattern of [/\b(?:job|artifacts?)\s+(?:for\s+|of\s+)?([\w][\w.:-]*)/i, /\b(?:for|of)\s+(?:the\s+)?(?:job\s+)?([\w][\w.:-]*)/i]) {
    const id = message.match(pattern)?.[1];
    if (id && !/^(the|a|an|it|this|that|please|job)$/i.test(id)) return id;
  }
  return undefined;
}

export type ChatIntent = "create_job" | "establish_strategy" | "revise_strategy" | "advance_plan" | "manage_calendar" | "status" | "list_artifacts" | "approve" | "effect_request" | "unknown";
export type ChatSourceDescriptor = { kind: "youtube" | "web"; url: string } | { kind: "pasted_text"; title: string; text: string };
export interface ParsedIntent { intent: ChatIntent; sources?: ChatSourceDescriptor[]; desiredOutputs?: OutputKind[]; libraryName?: string; jobId?: string; userOutcome?: string; assumptions?: string[]; needsClarification?: boolean; clarifyingQuestion?: string; requiresRightsAttestation?: boolean; workspaceContext?: WorkspaceContentContext; platformRecommendations?: string[]; connectionSuggestions?: string[] }

export function parseLocalIntent(message: string): ParsedIntent {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();
  const jobId = extractJobId(trimmed);
  if (/\bapprove\b/.test(lower)) return { intent: "approve", jobId };
  if (/\bartifacts?\b/.test(lower)) return { intent: "list_artifacts", jobId };
  if (/\bstatus\b/.test(lower)) return { intent: "status", jobId };
  const libraryName = trimmed.match(/\b(?:brand\s+)?library\s+["“]([^"”]+)["”]/i)?.[1]?.trim();
  const urls = trimmed.match(URL_RE) ?? [];
  if (urls.length || libraryName || trimmed.length >= 20) {
    const sources: ChatSourceDescriptor[] = urls.map((url) => ({ kind: YOUTUBE_RE.test(url) ? "youtube" : "web", url }));
    const remaining = trimmed.replace(URL_RE, "").replace(/\n?Use brand library ["“][^"”]+["”]\.??/gi, "").replace(/^(please\s+)?(make|create|start|run|generate|write)\s+(content|posts?)?\s*(from|about)?\s*/i, "").trim();
    if (remaining.length >= 20 && !/^content from the selected brand library\.?$/i.test(remaining)) sources.push({ kind: "pasted_text", title: "Operator context", text: remaining });
    return { intent: "create_job", sources, libraryName };
  }
  return { intent: "unknown" };
}

export async function parseIntent(message: string, attachmentCount = 0, recentConversation: Array<{ role: "user" | "assistant"; text: string }> = []): Promise<ParsedIntent> {
  const workspaceContext = await loadWorkspaceContentContext();
  const route = await requestIntentRoute({ message, workspaceContext, attachmentCount, recentConversation });
  const sources: ChatSourceDescriptor[] = route.sourceUrls.map((url) => ({ kind: YOUTUBE_RE.test(url) ? "youtube" : "web", url }));
  const desiredOutputs = route.outputConcepts.map((concept) => OUTPUT_CONCEPT_TO_KIND[concept]).flatMap((kind) => {
    const parsed = outputKindSchema.safeParse(kind);
    return parsed.success && OUTPUT_CAPABILITIES[parsed.data].state !== "unavailable" ? [parsed.data] : [];
  });
  const common = { sources, desiredOutputs, jobId: route.jobId ?? undefined, userOutcome: route.userOutcome, assumptions: route.assumptions, needsClarification: route.needsClarification, clarifyingQuestion: route.clarifyingQuestion ?? undefined, requiresRightsAttestation: route.requiresRightsAttestation, workspaceContext, platformRecommendations: route.platformRecommendations, connectionSuggestions: route.connectionSuggestions };
  if (route.intent === "repurpose_source" || route.intent === "one_off_content") return { intent: "create_job", ...common };
  if (route.intent === "status_evidence") return { intent: /artifact|draft|content/i.test(message) ? "list_artifacts" : "status", ...common };
  if (route.intent === "effect_request") return { intent: /approv|review|accept/i.test(message) ? "approve" : "effect_request", ...common };
  if (["establish_strategy", "revise_strategy", "advance_plan", "manage_calendar"].includes(route.intent)) return { intent: route.intent as ChatIntent, ...common };
  return { intent: "unknown", ...common };
}
