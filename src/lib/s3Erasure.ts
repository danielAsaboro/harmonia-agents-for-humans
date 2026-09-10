import {
  S3Client,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { awsConnection } from "./awsTransport";
/** Delete every version and marker for an explicitly authorized object or prefix. */
export async function eraseS3Versions(
  bucket: string,
  prefix: string,
  exact = false,
): Promise<void> {
  if (bucket !== process.env.S3_BUCKET || !prefix || prefix.includes(".."))
    throw new Error("invalid S3 erasure scope");
  const config = awsConnection("s3");
  const client = new S3Client({ ...config, forcePathStyle: !!config.endpoint });
  do {
    const page = await client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 1000,
      }),
    );
    const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
      .filter((v) => v.Key && (!exact || v.Key === prefix))
      .map((v) => ({ Key: v.Key!, VersionId: v.VersionId }));
    if (objects.length) {
      const deleted = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
      if (deleted.Errors?.length)
        throw new Error(
          "S3 version erasure incomplete; retry durable deletion",
        );
    }
    if (!objects.length) return;
  } while (true);
}
