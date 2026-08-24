import { tenantHandler } from "@/lib/auth";
import { handleChat } from "@/lib/chatHandler";

export type {
  ChatAsset,
  ChatAttachmentSummary,
  ChatResponse,
  JobCard,
  PendingActionSummary,
} from "@/lib/chatHandler";

export const POST = tenantHandler((req: Request) => handleChat(req));
