import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { s3Client } from "../storage";
import { currentTenant } from "../tenancy";
export interface AuthorizedS3Library {
  bucket: string;
  prefix: string;
}
export function authorizedS3Libraries(): AuthorizedS3Library[] {
  const configured = JSON.parse(
    process.env.HARMONIA_S3_LIBRARIES_JSON ?? "{}",
  ) as Record<string, AuthorizedS3Library[]>;
  const t = currentTenant();
  const entries = configured[`${t.workspaceId}/${t.brandId}`] ?? [];
  return entries.filter(
    (v) =>
      typeof v.bucket === "string" &&
      typeof v.prefix === "string" &&
      !v.prefix.split("/").includes(".."),
  );
}
export function requireS3Library(bucket: string, prefix: string) {
  if (
    prefix.split("/").includes("..") ||
    !authorizedS3Libraries().some(
      (v) =>
        v.bucket === bucket &&
        (prefix === v.prefix ||
          prefix.startsWith(
            v.prefix.endsWith("/") ? v.prefix : v.prefix + "/",
          )),
    )
  )
    throw new Error("S3 library prefix is not authorized for this tenant");
}
export async function listS3LibraryObjects(
  bucket: string,
  prefix: string,
  continuationToken?: string,
) {
  requireS3Library(bucket, prefix);
  const client = s3Client();
  const page = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 100,
    }),
  );
  const objects = [];
  for (const item of page.Contents ?? []) {
    if (!item.Key || item.Key.endsWith("/")) continue;
    const head = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: item.Key }),
    );
    if (!head.VersionId || head.VersionId === "null")
      throw new Error("S3 brand libraries require bucket versioning");
    objects.push({
      name: item.Key,
      versionId: head.VersionId,
      size: head.ContentLength ?? 0,
      mime: head.ContentType ?? "application/octet-stream",
    });
  }
  return { objects, nextToken: page.NextContinuationToken };
}
export async function downloadS3LibraryObject(
  bucket: string,
  prefix: string,
  key: string,
  versionId: string,
) {
  requireS3Library(bucket, prefix);
  if (!key.startsWith(prefix) || !versionId || versionId === "null")
    throw new Error("invalid pinned S3 library object");
  const result = await s3Client().send(
    new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
  );
  return Buffer.from(await result.Body!.transformToByteArray());
}
