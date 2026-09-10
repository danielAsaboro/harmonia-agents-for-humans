import { awsRepository,limited,ordered,partition,recordKey } from "../dynamo";
import { db } from "../repository";
import { assertResourceWorkspace,currentTenant,tenantCollectionPath,validateTenantScope,type TenantScope } from "../tenancy";
import { agendaItemSchema,agendaSchema,attentionRequestSchema,autonomyCycleSchema,configurationRevisionSchema,experimentSchema,hypothesisSchema,observationSchema,reflectionSchema,type AutonomyCycle } from "./contracts";
import { claimCycle,transitionCycle,type CycleClaim,type CycleClaimResult } from "./cycles";

const collectionNames = {
  cycles: "autonomy_cycles", observations: "autonomy_observations", reflections: "autonomy_reflections",
  hypotheses: "autonomy_hypotheses", experiments: "autonomy_experiments", revisions: "autonomy_configuration_revisions",
  agendas: "autonomy_agendas", agenda_items: "autonomy_agenda_items", attention: "autonomy_attention_requests",
} as const;
export type ResidentCollection = keyof typeof collectionNames;
export function residentCollectionPath(scope: TenantScope, collection: ResidentCollection): string {
  validateTenantScope(scope); return tenantCollectionPath(scope, collectionNames[collection]);
}
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])); return value; }
export function assertImmutableRecord<T>(existing: T, candidate: T): T { if (JSON.stringify(canonical(existing)) !== JSON.stringify(canonical(candidate))) throw new Error("resident autonomy record is immutable"); return existing; }
function collection(name: ResidentCollection) { return partition(residentCollectionPath(currentTenant(), name)); }

export async function createResidentCycle(input: AutonomyCycle): Promise<{ created: boolean }> {
  const cycle = autonomyCycleSchema.parse(input); assertResourceWorkspace(currentTenant(), cycle); const ref = recordKey(collection("cycles").partition + "/" + cycle.id);
  return db().atomic(async (tx) => { const existing = await tx.read(ref); if (existing.present) return { created: false }; tx.insert(ref, cycle); return { created: true }; });
}
export async function getResidentCycle(id: string): Promise<AutonomyCycle | null> { const snapshot = await awsRepository().read(recordKey(collection("cycles").partition + "/" + id)); if (!snapshot.present) return null; const cycle = autonomyCycleSchema.parse(snapshot.value); assertResourceWorkspace(currentTenant(), cycle); return cycle; }
export async function listResidentCycles(limit = 100): Promise<AutonomyCycle[]> { const snapshots = await awsRepository().query(limited(ordered(collection("cycles"), "scheduledAt", "desc"), limit)); return snapshots.rows.map((doc) => autonomyCycleSchema.parse(doc.value)); }
export async function claimPersistedCycle(id: string, claim: CycleClaim): Promise<CycleClaimResult> {
  const ref = recordKey(collection("cycles").partition + "/" + id); return db().atomic(async (tx) => { const snapshot = await tx.read(ref); if (!snapshot.present) throw new Error("resident cycle not found"); const result = claimCycle(autonomyCycleSchema.parse(snapshot.value), claim); if (result.outcome === "execute") tx.patch(ref, result.cycle); else if (result.outcome === "uncertain" && result.cycle.state === "uncertain") tx.patch(ref, result.cycle); return result; });
}
export async function transitionPersistedCycle(id: string, input: Parameters<typeof transitionCycle>[1]): Promise<AutonomyCycle> { const ref = recordKey(collection("cycles").partition + "/" + id); return db().atomic(async (tx) => { const snapshot = await tx.read(ref); if (!snapshot.present) throw new Error("resident cycle not found"); const next = transitionCycle(autonomyCycleSchema.parse(snapshot.value), input); tx.patch(ref, next); return next; }); }

const immutableSchemas = { observations: observationSchema, reflections: reflectionSchema, hypotheses: hypothesisSchema, experiments: experimentSchema, revisions: configurationRevisionSchema, agendas: agendaSchema, agenda_items: agendaItemSchema, attention: attentionRequestSchema } as const;
export async function createImmutableResidentRecord<K extends keyof typeof immutableSchemas>(kind: K, input: unknown): Promise<{ created: boolean }> {
  const record = immutableSchemas[kind].parse(input) as { id: string; workspaceId: string; brandId: string }; assertResourceWorkspace(currentTenant(), record); const ref = recordKey(collection(kind).partition + "/" + record.id);
  return db().atomic(async (tx) => { const existing = await tx.read(ref); if (existing.present) { assertImmutableRecord(existing.value, record); return { created: false }; } tx.insert(ref, record); return { created: true }; });
}
export async function listResidentRecords<K extends keyof typeof immutableSchemas>(kind: K, limit = 100): Promise<unknown[]> { const snapshots = await awsRepository().query(limited(collection(kind), limit)); return snapshots.rows.map((doc) => immutableSchemas[kind].parse(doc.value)); }
