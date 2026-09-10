import { eraseS3Versions } from "./s3Erasure";
/** Tenant-scoped immutable S3 artifacts. Reads distinguish missing objects from provider failures. */
import { createHash } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { awsConnection } from "./awsTransport";
import { currentTenant } from "./tenancy";
export function artifactBucket(): string {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error("S3_BUCKET required");
  return bucket;
}
export function s3Client() {
  const cfg = awsConnection("s3");
  return new S3Client({ ...cfg, forcePathStyle: !!cfg.endpoint });
}
function assertKey(objectKey: string, prefixes: string[]) {
  if (
    objectKey.includes("..") ||
    objectKey.includes("\\") ||
    !prefixes.some((p) => objectKey.startsWith(p))
  )
    throw new Error("artifact key outside tenant storage scope");
}
function tenantPrefixes() {
  const t = currentTenant();
  return [
    `artifacts/${t.workspaceId}/${t.brandId}/`,
    `chat-attachments/${t.workspaceId}/${t.brandId}/`,
    `durable-artifacts/${t.workspaceId}/${t.brandId}/`,
  ];
}
export function durableArtifactUri(objectKey: string): string {
  assertKey(
    objectKey,
    tenantPrefixes().filter((p) => p.startsWith("durable-")),
  );
  return `s3://${artifactBucket()}/${objectKey}`;
}
export async function putS3Object(
  objectKey: string,
  bytes: Uint8Array,
  mime: string,
): Promise<void> {
  assertKey(objectKey, tenantPrefixes());
  const digest = createHash("sha256").update(bytes).digest("hex");
  try {
    await s3Client().send(
      new PutObjectCommand({
        Bucket: artifactBucket(),
        Key: objectKey,
        Body: bytes,
        ContentType: mime,
        Metadata: { sha256: digest },
        ChecksumSHA256: createHash("sha256").update(bytes).digest("base64"),
        IfNoneMatch: "*",
      }),
    );
  } catch (e) {
    if ((e as { name: string }).name !== "PreconditionFailed") throw e;
    const prior = await readS3Object(objectKey);
    if (!prior || createHash("sha256").update(prior).digest("hex") !== digest)
      throw new Error("immutable artifact conflict");
  }
}
export async function readS3Object(objectKey: string): Promise<Buffer | null> {
  assertKey(objectKey, tenantPrefixes());
  try {
    const result = await s3Client().send(
      new GetObjectCommand({ Bucket: artifactBucket(), Key: objectKey }),
    );
    const bytes = Buffer.from(await result.Body!.transformToByteArray());
    if (
      result.Metadata?.sha256 &&
      createHash("sha256").update(bytes).digest("hex") !==
        result.Metadata.sha256
    )
      throw new Error("artifact byte digest mismatch");
    return bytes;
  } catch (e) {
    if ((e as { name: string }).name === "NoSuchKey") return null;
    throw e;
  }
}
export async function putDurableArtifactObject(
  objectKey: string,
  bytes: Uint8Array,
  mime: string,
) {
  durableArtifactUri(objectKey);
  await putS3Object(objectKey, bytes, mime);
}
export async function getDurableArtifactObject(objectKey: string) {
  durableArtifactUri(objectKey);
  return readS3Object(objectKey);
}
function artifactKey(key: string) {
  const t = currentTenant();
  if (!/^[A-Za-z0-9._-]+$/.test(key) || key.includes(".."))
    throw new Error("invalid artifact key");
  return `artifacts/${t.workspaceId}/${t.brandId}/${key}`;
}
export async function putArtifact(
  key: string,
  bytes: Uint8Array,
  mime: string,
): Promise<string> {
  const objectKey = artifactKey(key);
  await putS3Object(objectKey, bytes, mime);
  return `s3://${artifactBucket()}/${objectKey}`;
}
export async function getArtifact(key: string): Promise<Buffer | null> {
  return readS3Object(artifactKey(key));
}
export async function deleteArtifactUri(uri: string): Promise<void> {
  const url = new URL(uri);
  const key = url.pathname.slice(1);
  if (url.protocol !== "s3:" || url.hostname !== artifactBucket())
    throw new Error("artifact URI outside configured bucket");
  assertKey(key, tenantPrefixes());
  await eraseS3Versions(artifactBucket(), key, true);
}
export async function deleteWorkspaceArtifactUri(
  uri: string,
  workspaceId: string,
): Promise<void> {
  if (currentTenant().workspaceId !== workspaceId)
    throw new Error("workspace artifact scope mismatch");
  const url = new URL(uri),
    key = url.pathname.slice(1);
  if (url.protocol !== "s3:" || url.hostname !== artifactBucket())
    throw new Error("artifact URI outside configured bucket");
  assertKey(key, [
    `artifacts/${workspaceId}/`,
    `chat-attachments/${workspaceId}/`,
    `durable-artifacts/${workspaceId}/`,
  ]);
  await eraseS3Versions(artifactBucket(), key, true);
}
