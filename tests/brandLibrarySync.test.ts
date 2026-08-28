import { describe, expect, it } from "vitest";
import { isSyncDue, nextSyncAt } from "@/lib/brandLibraries/sync";
const connection = { cadence: "six_hours" as const, updatedAt: "2026-08-30T00:00:00Z" };
describe("brand library cadence", () => {
  it("defaults the next six-hour checkpoint exactly", () => expect(nextSyncAt(connection)).toBe("2026-08-30T06:00:00.000Z"));
  it("becomes due at the checkpoint", () => expect(isSyncDue(connection, "2026-08-30T06:00:00Z")).toBe(true));
  it("never schedules paused libraries", () => expect(nextSyncAt({ ...connection, cadence: "paused" })).toBeNull());
});
