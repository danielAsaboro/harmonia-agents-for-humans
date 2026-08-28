import { getConfig } from "./config";
import type { OutputKind } from "./types";

export function isMockAi(): boolean { return process.env.HARMONIA_MOCK_AI === "1"; }

const URL_RE = /https?:\/\/[^\s<>"]+/gi;
const YOUTUBE_RE = /(?:youtube\.com\/(?:watch\?\S*v=|shorts\/)|youtu\.be\/)/i;

function extractJobId(message: string): string | undefined {
  for (const pattern of [/\b(?:job|drafts?)\s+(?:for\s+|of\s+)?([\w][\w.:-]*)/i, /\b(?:for|of)\s+(?:the\s+)?(?:job\s+)?([\w][\w.:-]*)/i]) {
    const id = message.match(pattern)?.[1];
    if (id && !/^(the|a|an|it|this|that|please|job)$/i.test(id)) return id;
  }
  return undefined;
}

export type ChatIntent = "create_job" | "status" | "list_drafts" | "approve" | "unknown";
export type ChatSourceDescriptor = { kind: "youtube" | "web"; url: string } | { kind: "pasted_text"; title: string; text: string };
export interface ParsedIntent { intent: ChatIntent; sources?: ChatSourceDescriptor[]; desiredOutputs?: OutputKind[]; jobId?: string }

function offline(message: string): ParsedIntent {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();
  const jobId = extractJobId(trimmed);
  if (/\bapprove\b/.test(lower)) return { intent: "approve", jobId };
  if (/\bdrafts?\b/.test(lower)) return { intent: "list_drafts", jobId };
  if (/\bstatus\b/.test(lower)) return { intent: "status", jobId };
  const urls = trimmed.match(URL_RE) ?? [];
  if (urls.length || trimmed.length >= 20) {
    const sources: ChatSourceDescriptor[] = urls.map((url) => ({ kind: YOUTUBE_RE.test(url) ? "youtube" : "web", url }));
    const remaining = trimmed.replace(URL_RE, "").replace(/^(please\s+)?(make|create|start|run|generate|write)\s+(content|posts?)?\s*(from|about)?\s*/i, "").trim();
    if (remaining.length >= 20) sources.push({ kind: "pasted_text", title: "Operator context", text: remaining });
    return { intent: "create_job", sources, desiredOutputs: ["x_post"] };
  }
  return { intent: "unknown" };
}

const schema = { type: "object", properties: {
  intent: { type: "string", enum: ["create_job", "status", "list_drafts", "approve", "unknown"] },
  sources: { type: "array", maxItems: 10, items: { type: "object", properties: { kind: { type: "string", enum: ["youtube", "web", "pasted_text"] }, url: { type: "string" }, title: { type: "string" }, text: { type: "string" } }, required: ["kind"] } },
  desiredOutputs: { type: "array", items: { type: "string" } }, jobId: { type: "string" },
}, required: ["intent"] } as const;

const prompt = `Classify Harmonia operator requests. A create_job request may contain YouTube URLs, public web URLs, or pasted factual context. Return sources as typed descriptors and desired output types. Never invent URLs, source text, identifiers, or approval. Status, draft listing, and approval commands may include a jobId. Return JSON only.`;

export async function parseIntent(message: string): Promise<ParsedIntent> {
  if (isMockAi()) return offline(message);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured for chat intent parsing");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${getConfig().MODEL_ID}:generateContent`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey }, body: JSON.stringify({ systemInstruction: { parts: [{ text: prompt }] }, contents: [{ role: "user", parts: [{ text: message }] }], generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0 } }), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Gemini intent parsing failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("");
  if (!text) throw new Error("Gemini returned no intent payload");
  const parsed = JSON.parse(text) as ParsedIntent;
  const intents: ChatIntent[] = ["create_job", "status", "list_drafts", "approve", "unknown"];
  return { intent: intents.includes(parsed.intent) ? parsed.intent : "unknown", sources: parsed.sources, desiredOutputs: parsed.desiredOutputs, jobId: typeof parsed.jobId === "string" ? parsed.jobId : undefined };
}
