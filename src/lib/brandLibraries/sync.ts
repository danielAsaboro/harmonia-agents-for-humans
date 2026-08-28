import type { BrandLibraryConnection } from "./contracts";

const CADENCE_MS = { hourly: 3_600_000, six_hours: 21_600_000, daily: 86_400_000 } as const;
export function nextSyncAt(connection: Pick<BrandLibraryConnection, "cadence" | "updatedAt" | "pausedAt" | "revokedAt">): string | null {
  if (connection.cadence === "paused" || connection.pausedAt || connection.revokedAt) return null;
  return new Date(Date.parse(connection.updatedAt) + CADENCE_MS[connection.cadence]).toISOString();
}
export function isSyncDue(connection: Pick<BrandLibraryConnection, "cadence" | "updatedAt" | "pausedAt" | "revokedAt">, now: string): boolean {
  const next = nextSyncAt(connection); return Boolean(next && Date.parse(next) <= Date.parse(now));
}
