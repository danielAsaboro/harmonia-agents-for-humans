import { getConfig } from "./config";
import type { OutputKind } from "./types";
import { outputKindSchema } from "./contracts";
import { OUTPUT_CAPABILITIES } from "./outputCapabilities";

const URL_RE = /https?:\/\/[^\s<>"]+/gi;
const YOUTUBE_RE = /(?:youtube\.com\/(?:watch\?\S*v=|shorts\/)|youtu\.be\/)/i;

function extractJobId(message: string): string | undefined {
  for (const pattern of [/\b(?:job|artifacts?)\s+(?:for\s+|of\s+)?([\w][\w.:-]*)/i, /\b(?:for|of)\s+(?:the\s+)?(?:job\s+)?([\w][\w.:-]*)/i]) {
    const id = message.match(pattern)?.[1];
    if (id && !/^(the|a|an|it|this|that|please|job)$/i.test(id)) return id;
  }
  return undefined;
}

export type ChatIntent = "create_job" | "status" | "list_artifacts" | "approve"
  | "create_production_plan" | "revise_production_plan" | "explain_production_plan"
  | "approve_production_plan" | "production_status" | "rerender_production_plan" | "unknown";
export type ChatSourceDescriptor = { kind: "youtube" | "web"; url: string } | { kind: "pasted_text"; title: string; text: string };
export interface ParsedIntent { intent: ChatIntent; sources?: ChatSourceDescriptor[]; desiredOutputs?: OutputKind[]; libraryName?: string; jobId?: string; productionRequest?: string }

export function parseLocalIntent(message: string): ParsedIntent {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();
  const jobId = extractJobId(trimmed);
  if (/\b(?:re-?render|render again)\b/.test(lower) && /\b(?:production|media|paid assets?|job)\b/.test(lower)) {
    return { intent: "rerender_production_plan", jobId, productionRequest: trimmed };
  }
  if (/\bapprove\b/.test(lower) && /\b(?:production|media)\s+plan\b/.test(lower)) {
    return { intent: "approve_production_plan", jobId };
  }
  if (/\b(?:revise|change|update|replace|remove)\b/.test(lower)
    && /\b(?:production plan|soundtrack|shot|storyboard|media plan)\b/.test(lower)) {
    return { intent: "revise_production_plan", jobId, productionRequest: trimmed };
  }
  if (/\b(?:explain|why)\b/.test(lower) && /\b(?:model|production plan|media plan|shot|soundtrack)\b/.test(lower)) {
    return { intent: "explain_production_plan", jobId };
  }
  if (/\b(?:active|running|pending|report|status|progress)\b/.test(lower)
    && /\b(?:production|media)\s+(?:operations?|plan|status|progress)\b/.test(lower)) {
    return { intent: "production_status", jobId };
  }
  if (/\b(?:create|make|propose|draft|prepare)\b/.test(lower) && /\b(?:production|media)\s+plan\b/.test(lower)) {
    return { intent: "create_production_plan", jobId, productionRequest: trimmed };
  }
  if (/\bapprove\b/.test(lower)) return { intent: "approve", jobId };
  if (/\bartifacts?\b/.test(lower)) return { intent: "list_artifacts", jobId };
  if (/\bstatus\b/.test(lower)) return { intent: "status", jobId };
  const libraryName = trimmed.match(/\b(?:brand\s+)?library\s+["“]([^"”]+)["”]/i)?.[1]?.trim();
  const desiredLine = trimmed.match(/Desired outputs:\s*([^\n.]+)/i)?.[1];
  const desiredOutputs = desiredLine?.split(",").flatMap((item) => {
    const parsed = outputKindSchema.safeParse(item.trim());
    return parsed.success && OUTPUT_CAPABILITIES[parsed.data].state !== "unavailable" ? [parsed.data] : [];
  });
  const urls = trimmed.match(URL_RE) ?? [];
  if (urls.length || libraryName || trimmed.length >= 20) {
    const sources: ChatSourceDescriptor[] = urls.map((url) => ({ kind: YOUTUBE_RE.test(url) ? "youtube" : "web", url }));
    const remaining = trimmed.replace(URL_RE, "").replace(/\n?Use brand library ["“][^"”]+["”]\.??/gi, "").replace(/\n?Desired outputs:[^\n]+/gi, "").replace(/^(please\s+)?(make|create|start|run|generate|write)\s+(content|posts?)?\s*(from|about)?\s*/i, "").trim();
    if (remaining.length >= 20 && !/^content from the selected brand library\.?$/i.test(remaining)) sources.push({ kind: "pasted_text", title: "Operator context", text: remaining });
    return { intent: "create_job", sources, desiredOutputs: desiredOutputs?.length ? desiredOutputs : ["x_post"], libraryName };
  }
  return { intent: "unknown" };
}

const schema = { type: "object", properties: {
  intent: { type: "string", enum: ["create_job", "status", "list_artifacts", "approve", "create_production_plan", "revise_production_plan", "explain_production_plan", "approve_production_plan", "production_status", "rerender_production_plan", "unknown"] },
  sources: { type: "array", maxItems: 10, items: { type: "object", properties: { kind: { type: "string", enum: ["youtube", "web", "pasted_text"] }, url: { type: "string" }, title: { type: "string" }, text: { type: "string" } }, required: ["kind"] } },
  desiredOutputs: { type: "array", items: { type: "string" } }, libraryName: { type: "string" }, jobId: { type: "string" }, productionRequest: { type: "string" },
}, required: ["intent"] } as const;

const prompt = `Classify Harmonia operator requests. Distinguish production-plan creation, revision, model-selection explanation, approval, operation status, and cost-free rerendering from job creation and publication approval. Preserve the operator's exact production request in productionRequest; never invent plan controls. A create_job request may contain YouTube URLs, public web URLs, pasted factual context, and the exact name of an existing brand library. Return sources as typed descriptors, libraryName only when explicitly named, and desired output types. Never invent URLs, source text, library names, identifiers, or approval. Commands may include a jobId. Return JSON only.`;

export function normalizeParsedIntent(value: unknown): ParsedIntent {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const intents: ChatIntent[] = ["create_job", "status", "list_artifacts", "approve", "create_production_plan", "revise_production_plan", "explain_production_plan", "approve_production_plan", "production_status", "rerender_production_plan", "unknown"];
  const intent = typeof raw.intent === "string" && intents.includes(raw.intent as ChatIntent)
    ? raw.intent as ChatIntent
    : "unknown";
  const sources = Array.isArray(raw.sources) ? raw.sources.flatMap((item): ChatSourceDescriptor[] => {
    if (!item || typeof item !== "object") return [];
    const source = item as Record<string, unknown>;
    if ((source.kind === "youtube" || source.kind === "web") && typeof source.url === "string" && source.url.trim()) {
      return [{ kind: source.kind, url: source.url.trim() }];
    }
    if (source.kind === "pasted_text" && typeof source.text === "string" && source.text.trim()) {
      const title = typeof source.title === "string" && source.title.trim() ? source.title.trim() : "Operator context";
      return [{ kind: "pasted_text", title, text: source.text.trim() }];
    }
    return [];
  }) : [];
  const desiredOutputs = Array.isArray(raw.desiredOutputs) ? raw.desiredOutputs.flatMap((item) => {
    const result = outputKindSchema.safeParse(item);
    return result.success && OUTPUT_CAPABILITIES[result.data].state !== "unavailable" ? [result.data] : [];
  }) : [];
  return {
    intent,
    ...(sources.length ? { sources } : {}),
    ...(desiredOutputs.length ? { desiredOutputs } : {}),
    ...(typeof raw.libraryName === "string" && raw.libraryName.trim() ? { libraryName: raw.libraryName.trim() } : {}),
    ...(typeof raw.jobId === "string" && raw.jobId.trim() ? { jobId: raw.jobId.trim() } : {}),
    ...(typeof raw.productionRequest === "string" && raw.productionRequest.trim() ? { productionRequest: raw.productionRequest.trim() } : {}),
  };
}

export async function parseIntent(message: string): Promise<ParsedIntent> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured for chat intent parsing");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${getConfig().MODEL_ID}:generateContent`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey }, body: JSON.stringify({ systemInstruction: { parts: [{ text: prompt }] }, contents: [{ role: "user", parts: [{ text: message }] }], generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0 } }), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Gemini intent parsing failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("");
  if (!text) throw new Error("Gemini returned no intent payload");
  return normalizeParsedIntent(JSON.parse(text));
}
