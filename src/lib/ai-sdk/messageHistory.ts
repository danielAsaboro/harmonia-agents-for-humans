import { validateUIMessages } from "ai";
import type { HarmoniaMessage } from "@/components/ai-sdk/HarmoniaMessageRenderer";
import { parseHarmoniaSurfacePart } from "./contracts";

/** Validate untrusted persisted messages with AI SDK before applying Harmonia's stricter data contracts. */
export async function validatePersistedHarmoniaMessages(input: unknown): Promise<HarmoniaMessage[]> {
  const messages = await validateUIMessages<HarmoniaMessage>({ messages: input });
  for (const message of messages) for (const part of message.parts) {
    if (part.type === "data-harmonia-surface") parseHarmoniaSurfacePart(part);
  }
  return messages;
}
