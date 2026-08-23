import path from "node:path";
import { Storage } from "@google-cloud/storage";
import { db } from "./firestore";
import { newId } from "./idempotency";
import { getArtifact, putArtifact } from "./storage";
import { assertResourceWorkspace, currentTenant, tenantCollectionPath, type TenantScope } from "./tenancy";

export type AttachmentCategory = "image" | "video" | "audio" | "document";
export type AttachmentState = "pending" | "uploading" | "ready" | "failed";

const MIME_CATEGORY: Record<string, AttachmentCategory> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "image/gif": "image",
  "video/mp4": "video",
  "video/webm": "video",
  "video/quicktime": "video",
  "audio/mpeg": "audio",
  "audio/mp4": "audio",
  "audio/wav": "audio",
  "audio/webm": "audio",
  "application/pdf": "document",
  "text/plain": "document",
  "text/markdown": "document",
  "text/csv": "document",
};

const CATEGORY_LIMITS: Record<AttachmentCategory, number> = {
  image: 25 * 1024 * 1024,
  document: 50 * 1024 * 1024,
  // The current authenticated transcription path sends media inline to
  // Gemini, so uploads stay within its verified 24 MiB processing boundary.
  audio: 24 * 1024 * 1024,
  video: 24 * 1024 * 1024,
};

export interface AttachmentInput {
  filename: string;
  mime: string;
  sizeBytes: number;
}

export interface ValidAttachmentInput extends AttachmentInput {
  category: AttachmentCategory;
}

export interface ChatAttachment extends ValidAttachmentInput {
  id: string;
  workspaceId: string;
  brandId: string;
  createdByUserId: string;
  objectName: string;
  storageUri: string;
  state: AttachmentState;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export function validateAttachmentInput(input: AttachmentInput): ValidAttachmentInput {
  const filename = input.filename.trim();
  if (!filename || filename.length > 255 || input.sizeBytes <= 0 || !Number.isSafeInteger(input.sizeBytes)) {
    throw new Error("invalid attachment metadata");
  }
  const category = MIME_CATEGORY[input.mime];
  if (!category) throw new Error("unsupported attachment type");
  if (input.sizeBytes > CATEGORY_LIMITS[category]) {
    throw new Error(`attachment exceeds ${category} size limit`);
  }
  return { filename, mime: input.mime, sizeBytes: input.sizeBytes, category };
}

export function attachmentObjectName(scope: TenantScope, attachmentId: string, filename: string): string {
  const extension = path.extname(filename).slice(0, 12).toLowerCase().replace(/[^a-z0-9.]/g, "");
  return `chat-attachments/${scope.workspaceId}/${scope.brandId}/${attachmentId}${extension}`;
}

export function metadataMatchesAttachment(
  attachment: Pick<ChatAttachment, "mime" | "sizeBytes">,
  metadata: { contentType?: string | null; size?: string | number | null },
): boolean {
  return metadata.contentType === attachment.mime && Number(metadata.size) === attachment.sizeBytes;
}

function collection() {
  return db().collection(tenantCollectionPath(currentTenant(), "chat_attachments"));
}

export async function saveChatAttachment(attachment: ChatAttachment): Promise<void> {
  await collection().doc(attachment.id).set(attachment);
}

export async function getChatAttachment(id: string): Promise<ChatAttachment | null> {
  const snap = await collection().doc(id).get();
  if (!snap.exists) return null;
  const attachment = snap.data() as ChatAttachment;
  assertResourceWorkspace(currentTenant(), attachment);
  return attachment;
}

export async function requireReadyAttachments(ids: string[]): Promise<ChatAttachment[]> {
  const unique = [...new Set(ids)];
  if (unique.length > 20) throw new Error("too many attachments");
  const attachments = await Promise.all(unique.map((id) => getChatAttachment(id)));
  if (attachments.some((item) => !item || item.state !== "ready")) {
    throw new Error("attachment is missing or not ready");
  }
  return attachments as ChatAttachment[];
}

export interface AttachmentUploadSession {
  attachment: ChatAttachment;
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
}

export async function createAttachmentUploadSession(
  input: AttachmentInput,
  origin?: string,
): Promise<AttachmentUploadSession> {
  const valid = validateAttachmentInput(input);
  const tenant = currentTenant();
  const id = newId();
  const objectName = attachmentObjectName(tenant, id, valid.filename);
  const bucketName = process.env.GCS_BUCKET;
  const now = new Date().toISOString();
  const attachment: ChatAttachment = {
    ...valid,
    id,
    workspaceId: tenant.workspaceId,
    brandId: tenant.brandId,
    createdByUserId: tenant.userId,
    objectName,
    storageUri: bucketName ? `gs://${bucketName}/${objectName}` : `file://chat-attachments/${id}`,
    state: "pending",
    createdAt: now,
    updatedAt: now,
  };
  await saveChatAttachment(attachment);

  if (!bucketName) {
    return {
      attachment,
      uploadUrl: `/api/chat/attachments/${id}`,
      method: "PUT",
      headers: { "content-type": valid.mime },
    };
  }

  const file = new Storage().bucket(bucketName).file(objectName);
  const [uploadUrl] = await file.createResumableUpload({
    origin,
    metadata: {
      contentType: valid.mime,
      metadata: {
        attachmentId: id,
        workspaceId: tenant.workspaceId,
        brandId: tenant.brandId,
      },
    },
  });
  await collection().doc(id).set({ state: "uploading", updatedAt: new Date().toISOString() }, { merge: true });
  return { attachment: { ...attachment, state: "uploading" }, uploadUrl, method: "PUT", headers: { "content-type": valid.mime } };
}

export async function storeLocalAttachment(id: string, bytes: Uint8Array, mime: string): Promise<ChatAttachment> {
  const attachment = await getChatAttachment(id);
  if (!attachment) throw new Error("attachment not found");
  if (process.env.GCS_BUCKET) throw new Error("local attachment upload is disabled");
  if (mime !== attachment.mime || bytes.byteLength !== attachment.sizeBytes) {
    throw new Error("uploaded bytes do not match attachment metadata");
  }
  await putArtifact(`chat_attachment_${id}`, bytes, mime);
  const ready = { ...attachment, state: "ready" as const, updatedAt: new Date().toISOString() };
  await saveChatAttachment(ready);
  return ready;
}

export async function completeAttachmentUpload(id: string): Promise<ChatAttachment> {
  const attachment = await getChatAttachment(id);
  if (!attachment) throw new Error("attachment not found");
  if (attachment.state === "ready") return attachment;
  const bucketName = process.env.GCS_BUCKET;
  if (!bucketName) throw new Error("local upload has not completed");
  const [metadata] = await new Storage().bucket(bucketName).file(attachment.objectName).getMetadata();
  if (!metadataMatchesAttachment(attachment, metadata)) {
    await collection().doc(id).set({ state: "failed", error: "cloud object metadata mismatch", updatedAt: new Date().toISOString() }, { merge: true });
    throw new Error("cloud object metadata mismatch");
  }
  const ready = { ...attachment, state: "ready" as const, updatedAt: new Date().toISOString() };
  await saveChatAttachment(ready);
  return ready;
}

export async function getAttachmentDelivery(id: string): Promise<{ redirect?: string; bytes?: Buffer; mime: string }> {
  const attachment = await getChatAttachment(id);
  if (!attachment || attachment.state !== "ready") throw new Error("attachment not ready");
  const bucketName = process.env.GCS_BUCKET;
  if (bucketName) {
    const [redirect] = await new Storage().bucket(bucketName).file(attachment.objectName).getSignedUrl({ action: "read", expires: Date.now() + 5 * 60 * 1000, responseType: attachment.mime });
    return { redirect, mime: attachment.mime };
  }
  const bytes = await getArtifact(`chat_attachment_${id}`);
  if (!bytes) throw new Error("attachment bytes not found");
  return { bytes, mime: attachment.mime };
}

export async function getAttachmentBytesForInternal(id: string): Promise<{ bytes: Buffer; attachment: ChatAttachment }> {
  const attachment = await getChatAttachment(id);
  if (!attachment || attachment.state !== "ready") throw new Error("attachment not ready");
  const bucketName = process.env.GCS_BUCKET;
  if (bucketName) {
    const [bytes] = await new Storage().bucket(bucketName).file(attachment.objectName).download();
    return { bytes, attachment };
  }
  const bytes = await getArtifact(`chat_attachment_${id}`);
  if (!bytes) throw new Error("attachment bytes not found");
  return { bytes, attachment };
}
