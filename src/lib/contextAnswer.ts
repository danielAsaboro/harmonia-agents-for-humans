/**
 * Grounded Q&A about a specific Harmonia record ("chat with any item").
 *
 * The operator selects an entity (job, content item, proposal) anywhere in
 * the dashboard and asks a question; the answer is generated strictly from
 * that record.s data.
 */
import { requestAgentAnswer } from "./agentAskClient";
import { getContentItem, getJob, getProposal } from "./repository";

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

/** Context is server-fetched under the current tenant and supplied as data, never instructions. */
export async function answerFromContext(question: string, record: Record<string, unknown>): Promise<string> {
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > 60_000) {
    throw new Error("The record exceeds the bounded contextual-answer size; select a narrower item.");
  }
  const result = await requestAgentAnswer(question, { contextRecord: record });
  return result.answer;
}
