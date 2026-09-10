import { currentTenant,tenantCollectionPath } from "@/lib/tenancy";
import { createHash } from "node:crypto";
import { after,awsRepository,field,limited,ordered,partition,recordKey,where,type StoredRecord } from "../dynamo";
import {
agentActivitySchema,
durableRuntimeSnapshotSchema,
type AgentActivity,
type AgentActivityData,
type DurableRuntimeSnapshot,
type ObservabilityPage,
type ObservabilityQuery,
} from "./schema";

const COLLECTION = "agent_activity";
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SCAN_CHUNK = 100;
const MAX_SCAN = 1_000;

interface ActivityCursor {
  occurredAt: string;
  id: string;
}

function collection() {
  return partition(tenantCollectionPath(currentTenant(), COLLECTION));
}

export function encodeActivityCursor(cursor: ActivityCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeActivityCursor(value: string): ActivityCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error();
    const record = parsed as Record<string, unknown>;
    if (typeof record.occurredAt !== "string" || Number.isNaN(Date.parse(record.occurredAt))) throw new Error();
    if (typeof record.id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(record.id)) throw new Error();
    return { occurredAt: new Date(record.occurredAt).toISOString(), id: record.id };
  } catch {
    throw new Error("invalid observability cursor");
  }
}

export function matchesActivityFilters(item: AgentActivity, filters: Partial<ObservabilityQuery>): boolean {
  if (filters.types?.length && !filters.types.includes(item.signalType)) return false;
  for (const key of ["agent", "stage", "outcome", "severity", "model", "tool", "jobId", "traceId"] as const) {
    if (filters[key] && item[key] !== filters[key]) return false;
  }
  const occurred = Date.parse(item.occurredAt);
  if (filters.since && occurred < Date.parse(filters.since)) return false;
  if (filters.until && occurred > Date.parse(filters.until)) return false;
  if (filters.q) {
    const needle = filters.q.toLowerCase();
    const haystack = [
      item.eventName, item.agent, item.stage, item.workflow, item.model, item.tool,
      item.jobId, item.invocationId, item.operationId, item.traceId, item.errorCategory,
      item.errorType,
    ].filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

export async function writeAgentActivity(input: AgentActivityData): Promise<{ id: string; duplicate: boolean }> {
  const tenant = currentTenant();
  if (input.workspaceId !== tenant.workspaceId || input.brandId !== tenant.brandId) {
    throw new Error("activity tenant mismatch");
  }
  const parsed = agentActivitySchema.parse(input);
  const id = `activity_${createHash("sha256").update([
    parsed.invocationId, parsed.signalType, parsed.eventName, parsed.traceId,
    parsed.spanId, parsed.occurredAt,
  ].join("|")).digest("hex").slice(0, 32)}`;
  const ref = recordKey(collection().partition + "/" + id);
  const snapshot = await awsRepository().read(ref);
  if (snapshot.present) return { id, duplicate: true };
  await awsRepository().insert(ref, {
    ...parsed,
    occurredAt: new Date(parsed.occurredAt).toISOString(),
    retentionDeleteAfter: new Date(Date.now() + RETENTION_MS).toISOString(),
  });
  return { id, duplicate: false };
}

function fromSnapshot(snapshot: StoredRecord): AgentActivity {
  const raw = snapshot.value as unknown as Record<string, unknown>;
  const occurred = raw.occurredAt;
  const occurredAt = new Date(String(occurred)).toISOString();
  const { retentionDeleteAfter: _retentionDeleteAfter, ...activity } = raw;
  const parsed = agentActivitySchema.parse({ ...activity, occurredAt });
  return { id: snapshot.id, ...parsed };
}

function facets(items: AgentActivity[]): ObservabilityPage["facets"] {
  const values = (key: "agent" | "stage" | "model" | "tool") =>
    [...new Set(items.map((item) => item[key]).filter((value): value is string => Boolean(value)))].sort();
  return { agents: values("agent"), stages: values("stage"), models: values("model"), tools: values("tool") };
}

export async function listAgentActivity(filters: ObservabilityQuery): Promise<ObservabilityPage> {
  let query = ordered(ordered(collection(), "occurredAt", "desc"), "__name__", "desc");
  if (filters.cursor) {
    const cursor = decodeActivityCursor(filters.cursor);
    query = after(query, [new Date(cursor.occurredAt).toISOString(), cursor.id]);
  }
  const matched: Array<{ item: AgentActivity; cursor: ActivityCursor }> = [];
  let scanned = 0;
  let lastScanned: ActivityCursor | null = null;
  let exhausted = false;
  while (matched.length <= filters.limit && scanned < MAX_SCAN && !exhausted) {
    const snapshot = await awsRepository().query(limited(query, SCAN_CHUNK));
    if (snapshot.empty) break;
    for (const doc of snapshot.rows) {
      const item = fromSnapshot(doc);
      const cursor = { occurredAt: item.occurredAt, id: item.id };
      lastScanned = cursor;
      scanned += 1;
      if (matchesActivityFilters(item, filters)) matched.push({ item, cursor });
      if (matched.length > filters.limit || scanned >= MAX_SCAN) break;
    }
    exhausted = snapshot.size < SCAN_CHUNK;
    if (!lastScanned || matched.length > filters.limit || scanned >= MAX_SCAN) break;
    query = after(ordered(ordered(collection(), "occurredAt", "desc"), "__name__", "desc"), [new Date(lastScanned.occurredAt).toISOString(), lastScanned.id]);
  }
  const hasMore = matched.length > filters.limit || (!exhausted && scanned >= MAX_SCAN);
  const visible = matched.slice(0, filters.limit);
  const cursorSource = matched.length > filters.limit
    ? visible.at(-1)?.cursor
    : hasMore ? lastScanned : null;
  const items = visible.map(({ item }) => item);
  return {
    items,
    nextCursor: cursorSource ? encodeActivityCursor(cursorSource) : null,
    hasMore,
    facets: facets(items),
  };
}

export function oldestLagSeconds(timestamps: string[], now = new Date().toISOString()): number {
  if (!timestamps.length) return 0;
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("invalid runtime snapshot timestamp");
  const valid = timestamps.map(Date.parse).filter(Number.isFinite);
  if (!valid.length) return 0;
  return Math.max(0, Math.min(30 * 24 * 60 * 60, Math.floor((nowMs - Math.min(...valid)) / 1000)));
}

export async function getDurableRuntimeSnapshot(now = new Date().toISOString()): Promise<DurableRuntimeSnapshot> {
  const tenant = currentTenant();
  const tenantCollection = (name: string) => partition(tenantCollectionPath(tenant, name));
  const [operations, inbox, outbox, unknown, observed, projections, artifacts, recovery] = await Promise.all([
    awsRepository().query(limited(where(tenantCollection("operations"), "state", "==", "claimed"), 100)),
    awsRepository().query(limited(where(tenantCollection("event_inbox"), "state", "==", "processing"), 100)),
    awsRepository().query(limited(where(tenantCollection("stage_outbox"), "state", "==", "claimed"), 100)),
    awsRepository().query(limited(where(tenantCollection("effect_commands"), "state", "==", "unknown"), 100)),
    awsRepository().query(limited(where(tenantCollection("effect_commands"), "state", "==", "observed"), 100)),
    awsRepository().query(limited(ordered(tenantCollection("context_projections"), "createdAt", "desc"), 100)),
    awsRepository().query(limited(tenantCollection("artifacts"), 100)),
    awsRepository().query(limited(ordered(tenantCollection("recovery_work"), "createdAt", "desc"), 100)),
  ]);
  const nowMs = Date.parse(now);
  const staleOperations = operations.rows.filter((doc) => Date.parse(String(field(doc.value, "leaseExpiresAt") ?? "")) <= nowMs);
  const staleInbox = inbox.rows.filter((doc) => Date.parse(String(field(doc.value, "claimUntil") ?? "")) <= nowMs);
  const staleOutbox = outbox.rows.filter((doc) => Date.parse(String(field(doc.value, "claimUntil") ?? "")) <= nowMs);
  const latestProjection = projections.rows[0];
  const artifactStates = artifacts.rows.map((doc) => String(field(doc.value, "state")));
  return durableRuntimeSnapshotSchema.parse({
    generatedAt: now,
    staleLeases: { operations: staleOperations.length, inbox: staleInbox.length, outbox: staleOutbox.length },
    inboxLagSeconds: oldestLagSeconds(inbox.rows.map((doc) => String(field(doc.value, "receivedAt") ?? field(doc.value, "updatedAt") ?? now)), now),
    outboxLagSeconds: oldestLagSeconds(outbox.rows.map((doc) => String(field(doc.value, "createdAt") ?? now)), now),
    unknownEffects: unknown.rows.map((doc) => ({
      jobId: String(field(doc.value, "jobId")), operationId: String(field(doc.value, "operationId")), commandId: doc.id,
      epoch: Number(field(doc.value, "operationEpoch")), reason: String(field(doc.value, "unknownReason") ?? "provider outcome unknown"),
      ...(field(doc.value, "dispatchedAt") ? { dispatchedAt: String(field(doc.value, "dispatchedAt")) } : {}),
    })),
    observedEffects: observed.size,
    projection: {
      count: projections.size,
      compilerVersion: latestProjection ? String(field(latestProjection.value, "compilerVersion")) : null,
      manifestDigest: latestProjection ? String(field(latestProjection.value, "manifestDigest")) : null,
    },
    artifacts: {
      ready: artifactStates.filter((state) => state === "ready").length,
      writing: artifactStates.filter((state) => state === "writing").length,
      failed: artifactStates.filter((state) => state === "failed").length,
    },
    recovery: {
      pending: recovery.rows.filter((doc) => field(doc.value, "state") === "pending").length,
      recentActions: recovery.rows.map((doc) => String(field(doc.value, "action"))).filter(Boolean),
    },
  });
}
