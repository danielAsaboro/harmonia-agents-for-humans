import { awsConnection } from "./awsTransport";
import { eraseS3Versions } from "./s3Erasure";
/** Native DynamoDB record repository. Atomic commits fence every read and queried partition. */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash, randomUUID } from "node:crypto";

export type RecordValue = Record<string, unknown>;
export interface RecordKey {
  partition: string;
  id: string;
  path: string;
}
export interface StoredRecord<T = RecordValue> {
  id: string;
  key: RecordKey;
  present: boolean;
  value: T | undefined;
  revision: number;
  blob?: { bucket: string; key: string; sha256: string };
}
export interface RecordPage<T = RecordValue> {
  rows: StoredRecord<T>[];
  empty: boolean;
  size: number;
}
export type PredicateOperator =
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "in"
  | "not-in"
  | "array-contains"
  | "array-contains-any";
export interface PartitionQuery {
  partition: string;
  id: string;
  path: string;
  predicates: [string, PredicateOperator, unknown][];
  order: [string, "asc" | "desc"][];
  maximum?: number;
  cursor?: unknown[];
}
export const REMOVE_FIELD = Symbol("remove-field");
export function partition(path: string): PartitionQuery {
  if (!path || path.includes("..")) throw new Error("invalid partition");
  return {
    partition: path,
    path,
    id: path.split("/").at(-1)!,
    predicates: [],
    order: [],
  };
}
export function recordKey(path: string): RecordKey {
  const split = path.lastIndexOf("/");
  if (
    split < 1 ||
    path.includes("..") ||
    path.slice(split + 1).startsWith("!") ||
    !path.slice(split + 1)
  )
    throw new Error("invalid record key");
  return { partition: path.slice(0, split), id: path.slice(split + 1), path };
}
export const newRecordId = () => randomUUID();
export const where = (
  q: PartitionQuery,
  name: string,
  op: PredicateOperator,
  value: unknown,
): PartitionQuery => ({
  ...q,
  predicates: [...q.predicates, [name, op, value]],
});
export const ordered = (
  q: PartitionQuery,
  name: string,
  direction: "asc" | "desc" = "asc",
): PartitionQuery => ({ ...q, order: [...q.order, [name, direction]] });
export const limited = (q: PartitionQuery, maximum: number): PartitionQuery => {
  if (!Number.isSafeInteger(maximum) || maximum < 1)
    throw new Error("invalid query limit");
  return { ...q, maximum };
};
export const after = (
  q: PartitionQuery,
  cursor: unknown[],
): PartitionQuery => ({ ...q, cursor });
export function field(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (v, k) =>
        v && typeof v === "object" ? (v as RecordValue)[k] : undefined,
      value,
    );
}
function setField(value: RecordValue, path: string, item: unknown): void {
  const names = path.split(".");
  let current = value;
  for (const name of names.slice(0, -1)) {
    if (["__proto__", "constructor", "prototype"].includes(name))
      throw new Error("invalid field");
    current[name] = { ...((current[name] as RecordValue) ?? {}) };
    current = current[name] as RecordValue;
  }
  const last = names.at(-1)!;
  if (["__proto__", "constructor", "prototype"].includes(last))
    throw new Error("invalid field");
  if (item === REMOVE_FIELD) delete current[last];
  else if (item !== undefined) current[last] = item;
}
function mergeMap(base: RecordValue, patch: RecordValue): RecordValue {
  const result = { ...base };
  for (const [name, value] of Object.entries(patch)) {
    if (value === REMOVE_FIELD) delete result[name];
    else if (value !== undefined) {
      result[name] =
        value && typeof value === "object" && !Array.isArray(value)
          ? mergeMap(
              result[name] &&
                typeof result[name] === "object" &&
                !Array.isArray(result[name])
                ? (result[name] as RecordValue)
                : {},
              value as RecordValue,
            )
          : value;
    }
  }
  return result;
}
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined && v !== REMOVE_FIELD)
        .map(([k, v]) => [k, clean(v)]),
    );
  return value;
}
function compare(a: unknown, b: unknown): number {
  return a === b
    ? 0
    : a === undefined
      ? -1
      : b === undefined
        ? 1
        : (a as string | number) < (b as string | number)
          ? -1
          : 1;
}
function matches(
  value: RecordValue,
  p: PartitionQuery["predicates"][number],
): boolean {
  const a = field(value, p[0]) as string | number | unknown[],
    b = p[2] as string | number | unknown[];
  switch (p[1]) {
    case "==":
      return JSON.stringify(a) === JSON.stringify(b);
    case "!=":
      return a !== undefined && JSON.stringify(a) !== JSON.stringify(b);
    case "<":
      return a !== undefined && a < b;
    case "<=":
      return a !== undefined && a <= b;
    case ">":
      return a !== undefined && a > b;
    case ">=":
      return a !== undefined && a >= b;
    case "in":
      return (b as unknown[]).includes(a);
    case "not-in":
      return a !== undefined && !(b as unknown[]).includes(a);
    case "array-contains":
      return Array.isArray(a) && a.includes(b);
    case "array-contains-any":
      return Array.isArray(a) && a.some((v) => (b as unknown[]).includes(v));
  }
}
function settings() {
  const endpoint = process.env.AWS_LOCAL_ENDPOINT;
  if (
    endpoint &&
    !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(endpoint)
  )
    throw new Error("AWS_LOCAL_ENDPOINT must be loopback");
  if (!endpoint && process.env.HARMONIA_ALLOW_PAID_AWS !== "true")
    throw new Error(
      "AWS operations disabled: HARMONIA_ALLOW_PAID_AWS must be true",
    );
  const table = process.env.DYNAMODB_TABLE;
  if (!table) throw new Error("DYNAMODB_TABLE required");
  return { table, region: process.env.AWS_REGION ?? "us-east-1", endpoint };
}
export class UnknownCommitOutcome extends Error {
  constructor(cause: unknown) {
    super(
      "DynamoDB commit outcome is unknown; reconcile persisted authority before replay",
      { cause },
    );
  }
}
interface Mutation {
  kind: "put" | "insert" | "patch" | "remove";
  value?: RecordValue;
  merge?: boolean;
}
export class DynamoTransaction {
  readonly reads = new Map<string, StoredRecord>();
  private readonly pendingReads = new Map<string, Promise<StoredRecord>>();
  private readonly pendingFences = new Map<string, Promise<void>>();
  readonly fences = new Map<string, number>();
  readonly writes = new Map<string, { key: RecordKey; mutation: Mutation }>();
  constructor(private store: DynamoRepository) {}
  async read(key: PartitionQuery): Promise<RecordPage>;
  async read(key: RecordKey): Promise<StoredRecord>;
  async read(
    key: RecordKey | PartitionQuery,
  ): Promise<StoredRecord | RecordPage> {
    if ("predicates" in key) {
      await this.fence(key.partition);
      const page = await this.store.query(key);
      return page;
    }
    const existing = this.reads.get(key.path);
    if (existing) return existing;
    let pending = this.pendingReads.get(key.path);
    if (!pending) {
      pending = this.store.read(key).then((row) => {
        this.reads.set(key.path, row);
        return row;
      });
      this.pendingReads.set(key.path, pending);
    }
    return pending;
  }
  async fence(partition: string) {
    if (this.fences.has(partition)) return;
    let pending = this.pendingFences.get(partition);
    if (!pending) {
      pending = this.store.partitionRevision(partition).then((revision) => {
        this.fences.set(partition, revision);
      });
      this.pendingFences.set(partition, pending);
    }
    await pending;
  }
  put(key: RecordKey, value: unknown, options?: { merge?: boolean }): this {
    return this.write(key, {
      kind: "put",
      value: value as RecordValue,
      merge: options?.merge,
    });
  }
  insert(key: RecordKey, value: unknown): this {
    return this.write(key, { kind: "insert", value: value as RecordValue });
  }
  patch(key: RecordKey, value: unknown): this {
    return this.write(key, { kind: "patch", value: value as RecordValue });
  }
  remove(key: RecordKey): this {
    return this.write(key, { kind: "remove" });
  }
  private write(key: RecordKey, mutation: Mutation): this {
    const prior = this.writes.get(key.path)?.mutation;
    if (
      prior &&
      (mutation.kind === "patch" || mutation.merge) &&
      prior.kind !== "remove"
    ) {
      const value = { ...(prior.value ?? {}) };
      for (const [name, item] of Object.entries(mutation.value ?? {}))
        setField(value, name, item);
      this.writes.set(key.path, { key, mutation: { ...prior, value } });
    } else this.writes.set(key.path, { key, mutation });
    return this;
  }
}
export class DynamoRepository {
  private client?: DynamoDBDocumentClient;
  private wire() {
    const config = settings();
    this.client ??= DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: config.region, endpoint: config.endpoint }),
      { marshallOptions: { removeUndefinedValues: true } },
    );
    return { client: this.client, table: config.table };
  }
  async partitionRevision(pk: string): Promise<number> {
    const { client, table } = this.wire();
    const r = await client.send(
      new GetCommand({
        TableName: table,
        Key: { pk, sk: "!revision" },
        ConsistentRead: true,
      }),
    );
    return Number(r.Item?.revision ?? 0);
  }
  private async hydrate(
    item: RecordValue | undefined,
    key: RecordKey,
  ): Promise<StoredRecord> {
    if (!item)
      return { id: key.id, key, present: false, value: undefined, revision: 0 };
    let value = item.value as RecordValue;
    const blob = item.blob as
      { bucket: string; key: string; sha256: string } | undefined;
    if (blob) {
      const s3 = new S3Client({
        ...awsConnection("s3"),
        forcePathStyle: !!awsConnection("s3").endpoint,
      });
      if (blob.bucket !== process.env.S3_BUCKET)
        throw new Error("record blob bucket mismatch");
      const result = await s3.send(
        new GetObjectCommand({ Bucket: blob.bucket, Key: blob.key }),
      );
      const bytes = Buffer.from(await result.Body!.transformToByteArray());
      if (createHash("sha256").update(bytes).digest("hex") !== blob.sha256)
        throw new Error("record blob digest mismatch");
      value = JSON.parse(bytes.toString("utf8"));
    }
    return {
      id: key.id,
      key,
      present: true,
      value,
      revision: Number(item.revision),
      ...(blob ? { blob } : {}),
    };
  }
  async read(key: RecordKey): Promise<StoredRecord> {
    const { client, table } = this.wire();
    const result = await client.send(
      new GetCommand({
        TableName: table,
        Key: { pk: key.partition, sk: key.id },
        ConsistentRead: true,
      }),
    );
    return this.hydrate(result.Item, key);
  }
  async readMany(...keys: RecordKey[]): Promise<StoredRecord[]> {
    return Promise.all(keys.map((key) => this.read(key)));
  }
  async query(query: PartitionQuery): Promise<RecordPage> {
    const { client, table } = this.wire();
    let cursor: RecordValue | undefined;
    const rows: StoredRecord[] = [];
    do {
      const result = await client.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": query.partition },
          ConsistentRead: true,
          ExclusiveStartKey: cursor,
        }),
      );
      for (const item of result.Items ?? []) {
        if (item.sk === "!revision") continue;
        const row = await this.hydrate(
          item,
          recordKey(query.partition + "/" + item.sk),
        );
        if (query.predicates.every((p) => matches(row.value!, p)))
          rows.push(row);
      }
      cursor = result.LastEvaluatedKey;
    } while (cursor);
    const order = query.order.length
      ? query.order
      : [["__name__", "asc"] as [string, "asc"]];
    const values = (r: StoredRecord) =>
      order.map(([name]) =>
        name === "__name__" ? r.id : field(r.value, name),
      );
    const cmp = (a: unknown[], b: unknown[]) => {
      for (let i = 0; i < order.length; i++) {
        const n = compare(a[i], b[i]) * (order[i][1] === "desc" ? -1 : 1);
        if (n) return n;
      }
      return 0;
    };
    rows.sort((a, b) => cmp(values(a), values(b)) || a.id.localeCompare(b.id));
    const selected = rows
      .filter((r) => !query.cursor || cmp(values(r), query.cursor) > 0)
      .slice(0, query.maximum);
    return {
      rows: selected,
      empty: selected.length === 0,
      size: selected.length,
    };
  }
  async put(
    key: RecordKey,
    value: unknown,
    options?: { merge?: boolean },
  ): Promise<void> {
    await this.atomic(async (tx) => {
      tx.put(key, value, options);
    });
  }
  async insert(key: RecordKey, value: unknown): Promise<void> {
    await this.atomic(async (tx) => {
      tx.insert(key, value);
    });
  }
  async patch(key: RecordKey, value: unknown): Promise<void> {
    await this.atomic(async (tx) => {
      tx.patch(key, value);
    });
  }
  async remove(key: RecordKey): Promise<void> {
    await this.atomic(async (tx) => {
      tx.remove(key);
    });
  }
  writeGroup() {
    const tx = new DynamoTransaction(this);
    return Object.assign(tx, { commit: () => this.commit(tx) });
  }
  async atomic<T>(work: (tx: DynamoTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const tx = new DynamoTransaction(this);
      const result = await work(tx);
      try {
        await this.commit(tx);
        return result;
      } catch (error) {
        if (
          (error as { name?: string }).name ===
            "TransactionCanceledException" &&
          (
            error as { CancellationReasons?: { Code?: string }[] }
          ).CancellationReasons?.every(
            (r) =>
              r.Code === "None" ||
              r.Code === "ConditionalCheckFailed" ||
              r.Code === "TransactionConflict",
          )
        ) {
          if (attempt < 4) continue;
        }
        throw error;
      }
    }
    throw new Error("transaction contention exhausted");
  }
  private async storedValue(
    key: RecordKey,
    value: RecordValue,
  ): Promise<RecordValue> {
    const bytes = Buffer.from(JSON.stringify(clean(value)));
    if (bytes.byteLength < 240 * 1024)
      return { value: JSON.parse(bytes.toString()) };
    const workspace = String(
      value.workspaceId ??
        key.partition.match(/^workspaces\/([^/]+)/)?.[1] ??
        "",
    );
    const brand = String(value.brandId ?? "workspace");
    if (!workspace || !/^[-\w]+$/.test(workspace) || !/^[-\w]+$/.test(brand))
      throw new Error("large records require explicit tenant scope");
    const bucket = process.env.S3_BUCKET;
    if (!bucket) throw new Error("S3_BUCKET required for large records");
    const sha256 = createHash("sha256").update(bytes).digest("hex"),
      objectKey = `${workspace}/${brand}/record-blobs/${createHash("sha256").update(key.path).digest("hex")}/${sha256}.json`;
    const s3 = new S3Client({
      ...awsConnection("s3"),
      forcePathStyle: !!awsConnection("s3").endpoint,
    });
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: bytes,
          ContentType: "application/json",
          IfNoneMatch: "*",
          ChecksumSHA256: createHash("sha256").update(bytes).digest("base64"),
        }),
      );
    } catch (e) {
      if ((e as { name: string }).name !== "PreconditionFailed") throw e;
    }
    return { blob: { bucket, key: objectKey, sha256 } };
  }
  private async commit(tx: DynamoTransaction): Promise<void> {
    if (!tx.writes.size) return;
    for (const { key } of tx.writes.values()) {
      await tx.fence(key.partition);
      if (!tx.reads.has(key.path)) await tx.read(key);
    }
    const { client, table } = this.wire();
    const items: NonNullable<
      import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]
    > = [];
    const actionCount =
      tx.reads.size +
      tx.fences.size +
      new Set([...tx.writes.values()].map((v) => v.key.partition)).size +
      [...tx.reads.entries()].filter(
        ([path, row]) =>
          row.blob && tx.writes.get(path)?.mutation.kind === "remove",
      ).length;
    if (actionCount > 100)
      throw new Error(
        `atomic operation requires ${actionCount} DynamoDB actions; limit is 100`,
      );
    const erasureWorkspaces = new Set<string>(
      [...tx.writes.values()].flatMap(({ key }) =>
        key.partition.startsWith("blob-deletions:")
          ? [key.partition.slice("blob-deletions:".length)]
          : [],
      ),
    );
    for (const [path, row] of tx.reads) {
      const change = tx.writes.get(path),
        key = { pk: row.key.partition, sk: row.key.id };
      const condition = row.present
        ? "revision = :revision"
        : "attribute_not_exists(pk)";
      const common = {
        TableName: table,
        Key: key,
        ConditionExpression: condition,
        ...(row.present
          ? { ExpressionAttributeValues: { ":revision": row.revision } }
          : {}),
      };
      if (!change) {
        items.push({ ConditionCheck: common });
        continue;
      }
      const m = change.mutation;
      if (m.kind === "insert" && row.present)
        throw new Error("record already exists");
      if (m.kind === "patch" && !row.present)
        throw new Error("record not found");
      if (m.kind === "remove") {
        items.push({ Delete: common });
        if (row.blob) {
          const workspace = row.key.path.match(/^workspaces\/([^/]+)/)?.[1];
          if (!workspace || !row.blob.key.startsWith(workspace + "/"))
            throw new Error("blob erasure tenant mismatch");
          erasureWorkspaces.add(workspace);
          const prefix = row.blob.key.slice(
            0,
            row.blob.key.lastIndexOf("/") + 1,
          );
          items.push({
            Put: {
              TableName: table,
              Item: {
                pk: `blob-deletions:${workspace}`,
                sk: createHash("sha256").update(prefix).digest("hex"),
                revision: 1,
                value: {
                  workspaceId: workspace,
                  bucket: row.blob.bucket,
                  prefix,
                  state: "pending",
                  createdAt: new Date().toISOString(),
                },
              },
            },
          });
        }
        continue;
      }
      let value: RecordValue;
      if (m.kind === "patch" || m.merge) {
        value = m.merge
          ? mergeMap(row.value ?? {}, m.value ?? {})
          : { ...(row.value ?? {}) };
        if (!m.merge)
          for (const [name, item] of Object.entries(m.value ?? {}))
            setField(value, name, item);
      } else value = clean(m.value ?? {}) as RecordValue;
      if (
        row.blob ||
        Buffer.byteLength(JSON.stringify(clean(value))) >= 240 * 1024
      ) {
        const workspace = String(
          value.workspaceId ??
            row.key.partition.match(/^workspaces\/([^/]+)/)?.[1] ??
            "",
        );
        const brand = String(value.brandId ?? "workspace");
        const prefix = `${workspace}/${brand}/record-blobs/${createHash("sha256").update(row.key.path).digest("hex")}/`;
        const erasure = await tx.read(
          recordKey(
            `blob-deletions:${workspace}/${createHash("sha256").update(prefix).digest("hex")}`,
          ),
        );
        const workspaceErasure = await tx.read(
          recordKey(`blob-deletions:${workspace}/workspace`),
        );
        if (erasure.present || workspaceErasure.present)
          throw new Error(
            "record blob scope was erased; use a new record identity",
          );
      }
      const stored = await this.storedValue(row.key, value);
      const { Key: _key, ...putCommon } = common;
      void _key;
      items.push({
        Put: {
          ...putCommon,
          Item: { ...key, revision: row.revision + 1, ...stored },
        },
      });
    }
    for (const [pk, revision] of tx.fences) {
      items.push({
        Put: {
          TableName: table,
          Item: { pk, sk: "!revision", revision: revision + 1 },
          ConditionExpression: revision
            ? "revision = :revision"
            : "attribute_not_exists(pk)",
          ...(revision
            ? { ExpressionAttributeValues: { ":revision": revision } }
            : {}),
        },
      });
    }
    for (const pk of new Set(
      [...tx.writes.values()].map((v) => v.key.partition),
    )) {
      const workspace = pk.match(/^workspaces\/([^/]+)/)?.[1] ?? "global";
      items.push({
        Put: {
          TableName: table,
          Item: {
            pk: `partition-registry:${workspace}`,
            sk: createHash("sha256").update(pk).digest("hex"),
            revision: 1,
            value: { namespace: pk },
          },
        },
      });
    }
    for (const workspaceId of erasureWorkspaces)
      items.push({
        Put: {
          TableName: table,
          Item: {
            pk: "blob-erasure-workspaces",
            sk: workspaceId,
            revision: 1,
            value: { workspaceId },
          },
        },
      });
    if (items.length > 100)
      throw new Error(
        `atomic operation requires ${items.length} DynamoDB actions; limit is 100`,
      );
    try {
      await client.send(
        new TransactWriteCommand({
          TransactItems: items,
          ClientRequestToken: randomUUID(),
        }),
      );
    } catch (e) {
      if (
        [
          "TransactionCanceledException",
          "ValidationException",
          "AccessDeniedException",
          "ResourceNotFoundException",
        ].includes((e as { name: string }).name)
      )
        throw e;
      throw new UnknownCommitOutcome(e);
    }
  }
  async childPartitions(key: RecordKey): Promise<PartitionQuery[]> {
    const workspace = key.path.match(/^workspaces\/([^/]+)/)?.[1] ?? "global";
    const page = await this.query(partition(`partition-registry:${workspace}`));
    const prefix = key.path + "/";
    return page.rows
      .map((row) => String(row.value?.namespace))
      .filter(
        (name) =>
          name.startsWith(prefix) && !name.slice(prefix.length).includes("/"),
      )
      .map(partition);
  }
  async removeTree(key: RecordKey): Promise<void> {
    const workspace = key.path.match(/^workspaces\/([^/]+)/)?.[1] ?? "global";
    const registry = await this.query(
      partition(`partition-registry:${workspace}`),
    );
    const namespaces = registry.rows
      .map((row) => String(row.value?.namespace))
      .filter((name) => name.startsWith(key.path + "/"))
      .sort((a, b) => b.length - a.length);
    for (const namespace of namespaces) {
      const rows = await this.query(partition(namespace));
      for (let i = 0; i < rows.rows.length; i += 25) {
        await this.atomic(async (tx) => {
          for (const row of rows.rows.slice(i, i + 25)) tx.remove(row.key);
        });
      }
    }
    await this.remove(key);
    await this.recoverBlobErasure(workspace);
  }
  async eraseWorkspaceBlobs(workspaceId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId))
      throw new Error("invalid workspace blob scope");
    await this.put(recordKey(`blob-deletions:${workspaceId}/workspace`), {
      workspaceId,
      bucket: process.env.S3_BUCKET,
      prefix: workspaceId + "/",
      state: "pending",
      createdAt: new Date().toISOString(),
    });
    await this.recoverBlobErasure(workspaceId);
  }
  async recoverPendingBlobErasures(): Promise<{
    recovered: string[];
    failed: string[];
  }> {
    const scopes = await this.query(partition("blob-erasure-workspaces"));
    const recovered: string[] = [],
      failed: string[] = [];
    for (const row of scopes.rows) {
      const workspaceId = row.value?.workspaceId;
      if (
        typeof workspaceId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)
      )
        throw new Error("invalid erasure recovery workspace");
      try {
        await this.recoverBlobErasure(workspaceId);
        recovered.push(workspaceId);
      } catch {
        failed.push(workspaceId);
      }
    }
    return { recovered, failed };
  }
  async recoverBlobErasure(workspaceId: string): Promise<void> {
    const pending = await this.query(
      partition(`blob-deletions:${workspaceId}`),
    );
    for (const row of pending.rows) {
      const value = row.value;
      if (value?.state === "completed") continue;
      if (
        value?.workspaceId !== workspaceId ||
        typeof value.prefix !== "string" ||
        !value.prefix.startsWith(workspaceId + "/") ||
        typeof value.bucket !== "string"
      )
        throw new Error("invalid durable blob erasure scope");
      await eraseS3Versions(value.bucket, value.prefix);
      await this.patch(row.key, {
        state: "completed",
        completedAt: new Date().toISOString(),
      });
    }
  }
}
let singleton: DynamoRepository | undefined;
export function awsRepository(): DynamoRepository {
  return (singleton ??= new DynamoRepository());
}
