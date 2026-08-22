/**
 * Grounded Q&A about a specific Harmonia record ("chat with any item").
 *
 * The operator selects an entity (job, content item, proposal) anywhere in
 * the dashboard and asks a question; the answer is generated strictly from
 * that record's data. With HARMONIA_MOCK_AI=1 the answer is composed
 * deterministically from the same fields - no network.
 */
import { getConfig } from "./config";
import { getContentItem, getJob, getProposal } from "./firestore";

export interface ChatContext {
  kind: "job" | "content_item" | "proposal";
  id: string;
}

export function isValidContext(value: unknown): value is ChatContext {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.kind === "job" || v.kind === "content_item" || v.kind === "proposal") &&
    typeof v.id === "string" &&
    v.id.length > 0
  );
}

/** Fetches the referenced record, or null when it does not exist. */
export async function fetchContextRecord(
  ctx: ChatContext,
): Promise<Record<string, unknown> | null> {
  try {
    if (ctx.kind === "job") return (await getJob(ctx.id)) as unknown as Record<string, unknown>;
    if (ctx.kind === "proposal") return (await getProposal(ctx.id)) as unknown as Record<string, unknown>;
    return (await getContentItem(ctx.id)) as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Deterministic offline answers composed from the record itself. */
export function mockContextAnswer(
  question: string,
  record: Record<string, unknown>,
  kind: ChatContext["kind"],
): string {
  if (kind === "job") {
    const verifications = Array.isArray(record.verifications)
      ? (record.verifications as Array<{ verified?: boolean }>)
      : [];
    const verifiedCount = verifications.filter((v) => v.verified).length;
    return (
      `(mock) Job ${record.id}: stage '${record.stage}' (${record.status}). ` +
      `${Array.isArray(record.drafts) ? record.drafts.length : 0} drafted post(s), ` +
      `${Array.isArray(record.actions) ? record.actions.length : 0} proposed action(s), ` +
      `${verifiedCount}/${verifications.length} verifications confirmed. ` +
      `Ask me to approve it or show drafts on the Console.`
    );
  }
  if (kind === "content_item") {
    return (
      `(mock) Content item ${record.id}: status '${record.status}', mode '${record.publishMode ?? "approval"}' for ${(record.platforms as string[])?.join(", ") ?? "x"}. ` +
      `Scheduled: ${record.scheduledFor ?? "not scheduled yet"}${record.publishedUrl ? `, published at ${record.publishedUrl}` : ""}.`
    );
  }
  return (
    `(mock) Proposal ${record.id}: source '${record.source}', status '${record.status}'. ` +
    `Topic: ${String(record.topic).slice(0, 120)}. Reason: ${String(record.reason).slice(0, 140)}`
  );
}

const SYSTEM_PROMPT = `You answer an operator's question about ONE Harmonia record.
You receive the record's full JSON plus the question. Answer ONLY with facts present
in the record - never invent ids, numbers, dates, or states. Be concise (max ~120 words).
If the record does not contain the answer, say exactly what is missing.`;

interface GeminiCandidatePart {
  text?: string;
}

export async function answerFromContext(
  question: string,
  record: Record<string, unknown>,
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured for contextual chat");
  const model = getConfig().MODEL_ID;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{
          role: "user",
          parts: [{ text: `Record JSON:\n${JSON.stringify(record).slice(0, 60000)}\n\nQuestion: ${question}` }],
        }],
        generationConfig: { temperature: 0 },
        signal: AbortSignal.timeout(20_000),
      }),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini contextual answer failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: GeminiCandidatePart[] } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
  if (!text) throw new Error("Gemini returned no contextual answer");
  return text.trim();
}
