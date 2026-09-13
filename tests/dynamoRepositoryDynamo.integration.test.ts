import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  ListObjectVersionsCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  awsRepository,
  recordKey,
  partition,
  REMOVE_FIELD,
} from "@/lib/dynamo";
import { s3Client } from "@/lib/storage";
const workspace = `native-${randomUUID()}`,
  root = `workspaces/${workspace}`,
  repo = awsRepository();
const key = (id: string) => recordKey(`${root}/records/${id}`);
describe.skipIf(!process.env.AWS_LOCAL_ENDPOINT)(
  "native DynamoDB transaction and blob contracts",
  () => {
    it("atomically retries query phantom conflicts and preserves recursively merged fields", async () => {
      await repo.put(key("parent"), {
        nested: { keep: 1, remove: 2 },
        count: 0,
      });
      await repo.put(recordKey(`${root}/children/first`), { ready: true });
      let first = true;
      await repo.atomic(async (tx) => {
        const rows = await tx.read(partition(`${root}/children`));
        if (first) {
          first = false;
          await repo.put(recordKey(`${root}/children/second`), { ready: true });
        }
        tx.patch(key("parent"), { count: rows.size });
      });
      await repo.put(
        key("parent"),
        { nested: { add: 3, remove: REMOVE_FIELD } },
        { merge: true },
      );
      expect((await repo.read(key("parent"))).value).toEqual({
        nested: { keep: 1, add: 3 },
        count: 2,
      });
    });
    it("fails an oversized atomic write without partially creating records", async () => {
      await expect(
        repo.atomic(async (tx) => {
          for (let n = 0; n < 101; n++)
            tx.insert(key(`oversize-${n}`), { value: n });
        }),
      ).rejects.toThrow("limit is 100");
      expect((await repo.read(key("oversize-0"))).present).toBe(false);
    });
    it("projects explicit expiration into DynamoDB's top-level TTL attribute", async () => {
      const expiring = key("expiring");
      await repo.put(expiring, { value: "ephemeral", ttlEpochSeconds: 1_795_478_400 });
      const wire = DynamoDBDocumentClient.from(new DynamoDBClient({
        region: process.env.AWS_REGION,
        endpoint: process.env.AWS_LOCAL_ENDPOINT,
      }));
      const stored = await wire.send(new GetCommand({
        TableName: process.env.DYNAMODB_TABLE,
        Key: { pk: expiring.partition, sk: expiring.id },
        ConsistentRead: true,
      }));
      expect(stored.Item?.ttlEpochSeconds).toBe(1_795_478_400);
      expect(stored.Item?.value.ttlEpochSeconds).toBe(1_795_478_400);
    });
    it("offloads a large tenant-bound value to S3 and detects stored byte corruption", async () => {
      const k = key("large"),
        value = {
          workspaceId: workspace,
          brandId: "brand",
          text: "verified-source ".repeat(25_000),
        };
      await repo.put(k, value);
      expect((await repo.read(k)).value).toEqual(value);
      const wire = DynamoDBDocumentClient.from(
        new DynamoDBClient({
          region: process.env.AWS_REGION,
          endpoint: process.env.AWS_LOCAL_ENDPOINT,
        }),
      );
      const stored = await wire.send(
        new GetCommand({
          TableName: process.env.DYNAMODB_TABLE,
          Key: { pk: k.partition, sk: k.id },
          ConsistentRead: true,
        }),
      );
      expect(stored.Item?.value).toBeUndefined();
      expect(stored.Item?.blob.key).toMatch(
        new RegExp(`^${workspace}/brand/record-blobs/`),
      );
      await s3Client().send(
        new PutObjectCommand({
          Bucket: stored.Item!.blob.bucket,
          Key: stored.Item!.blob.key,
          Body: Buffer.from("corrupted"),
        }),
      );
      await expect(repo.read(k)).rejects.toThrow("record blob digest mismatch");
      // Repair corruption so cleanup can reread the record before deleting it.
      await s3Client().send(
        new PutObjectCommand({
          Bucket: stored.Item!.blob.bucket,
          Key: stored.Item!.blob.key,
          Body: Buffer.from(JSON.stringify(value)),
        }),
      );
    });
    it("durably recovers version erasure without deleting another record with the same digest", async () => {
      const value = {
        workspaceId: workspace,
        brandId: "brand",
        text: "licensed-content".repeat(25_000),
      };
      const target = key("erase"),
        other = key("keep");
      await repo.put(target, value);
      await repo.put(other, value);
      const row = await repo.read(target);
      const blob = row.blob!;
      await s3Client().send(
        new PutObjectCommand({
          Bucket: blob.bucket,
          Key: blob.key,
          Body: Buffer.from(JSON.stringify(value)),
        }),
      );
      const versions = () =>
        s3Client().send(
          new ListObjectVersionsCommand({
            Bucket: blob.bucket,
            Prefix: blob.key,
          }),
        );
      expect((await versions()).Versions!.length).toBeGreaterThan(1);
      await repo.remove(target);
      const endpoint = process.env.AWS_S3_LOCAL_ENDPOINT;
      vi.stubEnv("AWS_S3_LOCAL_ENDPOINT", "http://127.0.0.1:1");
      await expect(repo.recoverBlobErasure(workspace)).rejects.toThrow();
      vi.stubEnv("AWS_S3_LOCAL_ENDPOINT", endpoint);
      expect(
        (await repo.query(partition(`blob-deletions:${workspace}`))).size,
      ).toBe(1);
      expect((await repo.recoverPendingBlobErasures()).recovered).toContain(
        workspace,
      );
      expect((await versions()).Versions ?? []).toHaveLength(0);
      expect((await repo.read(other)).value).toEqual(value);
      expect(
        (await repo.query(partition(`blob-deletions:${workspace}`))).rows.every(
          (row) => row.value?.state === "completed",
        ),
      ).toBe(true);
      await expect(repo.put(target, value)).rejects.toThrow(
        "record blob scope was erased",
      );
    });
    afterAll(async () => {
      await repo.removeTree(recordKey(root));
    });
  },
);
