/**
 * Natural-language intent parsing for operator surfaces (dashboard chat,
 * Telegram). Uses Gemini structured output so every surface shares one
 * intent grammar: create_job | status | list_drafts | approve | unknown.
 *
 * Offline dev mode: when HARMONIA_MOCK_AI=1, parseIntent() classifies with
 * deterministic keyword rules and never touches the network. With the flag
 * unset, behavior is exactly the real Gemini path.
 */
import { getConfig } from "./config";

export function isMockAi(): boolean {
  return process.env.HARMONIA_MOCK_AI === "1";
}

const YT_URL_RE = /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?\S*v=|shorts\/)|youtu\.be\/)[\w-]+/i;

/** Extracts a job id mentioned near "job"/"drafts"/"for"/"of" (mock parser only). */
function extractJobId(message: string): string | undefined {
  const patterns = [
    /\b(?:job|drafts?)\s+(?:for\s+|of\s+)?([\w][\w.:-]*)/i,
    /\b(?:for|of)\s+(?:the\s+)?(?:job\s+)?([\w][\w.:-]*)/i,
  ];
  for (const re of patterns) {
    const id = message.match(re)?.[1];
    if (id && !/^(the|a|an|it|this|that|please|job)$/i.test(id)) return id;
  }
  return undefined;
}

function parseIntentOffline(message: string): ParsedIntent {
  const trimmed = message.trim();
  const yt = trimmed.match(YT_URL_RE)?.[0];
  if (yt) {
    return { intent: "create_job", youtubeUrl: yt };
  }
  const lower = trimmed.toLowerCase();
  const jobId = extractJobId(trimmed);
  if (/\bapprove\b/.test(lower)) {
    return { intent: "approve", jobId };
  }
  if (/\bdrafts?\b/.test(lower)) {
    return { intent: "list_drafts", jobId };
  }
  if (/\bstatus\b/.test(lower)) {
    return { intent: "status", jobId };
  }
  if (trimmed.length >= 20) {
    const topic = trimmed
      .replace(
        /^(please\s+)?(can you\s+)?(make|create|start|run|generate|announce|post|share|write|publish)\s+(me\s+)?(a\s+|an\s+|some\s+)?(new\s+)?(posts?|content|announcement)?\s*(about|for|on|from)?\s*/i,
        "",
      )
      .replace(/^(turn|convert)\s+/i, "")
      .trim();
    return { intent: "create_job", topic: topic.length >= 20 ? topic : trimmed };
  }
  return { intent: "unknown" };
}

export type ChatIntent =
  | "create_job"
  | "status"
  | "list_drafts"
  | "approve"
  | "unknown";

export interface ParsedIntent {
  intent: ChatIntent;
  youtubeUrl?: string;
  jobId?: string;
  /** Topic/brief text when the operator wants content without a video. */
  topic?: string;
}

const INTENT_SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: ["create_job", "status", "list_drafts", "approve", "unknown"],
    },
    youtubeUrl: { type: "string" },
    jobId: { type: "string" },
    topic: { type: "string" },
  },
  required: ["intent"],
} as const;

const SYSTEM_PROMPT = `You parse operator commands for Harmonia, a social media content engine that turns videos OR raw topic briefs into drafted social posts.
Classify the message into exactly one intent:
- "create_job": the operator wants a new content job. If they give a YouTube video URL, extract it into youtubeUrl. If they instead describe a topic, product, announcement, or idea to post about, extract their description into topic (verbatim, cleaned of command phrasing like "make posts about").
- "status": asking about a job's progress/state. Extract the job id if given.
- "list_drafts": asking to see drafted posts for a job. Extract the job id if given.
- "approve": approving pending actions/drafts for publication. Extract the job id if given.
- "unknown": anything else (greetings, questions about the product, small talk).
Return only ids/urls actually present in the message; never invent them.`;

interface GeminiCandidatePart {
  text?: string;
}

export async function parseIntent(message: string): Promise<ParsedIntent> {
  if (isMockAi()) {
    const mock = parseIntentOffline(message);
    console.log(`[MOCK-AI] parseIntent offline: "${message.slice(0, 80)}" -> ${mock.intent}`);
    return mock;
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured for chat intent parsing");
  }
  const model = getConfig().MODEL_ID;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: message }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: INTENT_SCHEMA,
          temperature: 0,
        },
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini intent parsing failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: GeminiCandidatePart[] } }>;
  };
  const text = data.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? "")
    .join("");
  if (!text) throw new Error("Gemini returned no intent payload");
  let parsed: ParsedIntent;
  try {
    parsed = JSON.parse(text) as ParsedIntent;
  } catch {
    throw new Error("Gemini intent payload was not valid JSON");
  }
  const intents: ChatIntent[] = [
    "create_job",
    "status",
    "list_drafts",
    "approve",
    "unknown",
  ];
  return {
    intent: intents.includes(parsed.intent) ? parsed.intent : "unknown",
    youtubeUrl: typeof parsed.youtubeUrl === "string" ? parsed.youtubeUrl : undefined,
    jobId: typeof parsed.jobId === "string" ? parsed.jobId : undefined,
    topic: typeof parsed.topic === "string" && parsed.topic.trim() ? parsed.topic.trim() : undefined,
  };
}
