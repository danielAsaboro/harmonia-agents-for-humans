import { describe, expect, it } from "vitest";

describe("campaign planning authority", () => {
  it("has an explicit persisted policy contract and refuses an invented timezone default", async () => {
    const contracts = await import("@/lib/campaigns/contracts").catch(() => null);
    expect(contracts, "campaign authority contracts must exist").not.toBeNull();
    expect(contracts!.planningPolicySchema.safeParse({}).success).toBe(false);
  });
  it("uses local calendar weeks through DST instead of UTC week buckets", async () => {
    const commands = await import("@/lib/planning/commands").catch(() => null);
    expect(commands, "audited planning commands must exist").not.toBeNull();
    expect(commands!.localWeek("2026-11-02T00:30:00Z", "America/New_York")).toBe("2026-10-26");
    expect(commands!.localWeek("2026-11-02T05:30:00Z", "America/New_York")).toBe("2026-11-02");
  });
  it("enforces configured capacity and cadence across the brand calendar", async () => {
    const { calendarConflicts } = await import("@/lib/planning/commands");
    const ref = { workspaceId: "w", brandId: "b", id: "a", revision: 1 };
    const policy = { ref, configuredAt: "2026-01-01T00:00:00Z", configuredBy: "operator", timezone: "America/New_York", productionCapacity: { maxItems: 2, maxItemsPerWeek: 1 }, cadenceConstraints: { minimumHoursBetweenItems: 36, maxItemsPerChannelPerWeek: 1 }, maxConcurrentItems: 1 };
    expect(calendarConflicts({ ref, channel: "x", scheduledFor: "2026-11-02T06:00:00Z" }, [{ ref: { ...ref, id: "b" }, channel: "x", scheduledFor: "2026-11-02T12:00:00Z" }], policy)).toEqual(["weekly production capacity exceeded", "channel weekly cadence exceeded", "minimum channel spacing violated"]);
  });
  it("frees production capacity after completion while keeping same-week cadence history", async () => {
    const { calendarConflicts } = await import("@/lib/planning/commands");
    const ref = { workspaceId: "w", brandId: "b", id: "a", revision: 1 };
    const policy = { ref, configuredAt: "2026-01-01T00:00:00Z", configuredBy: "operator", timezone: "America/New_York", productionCapacity: { maxItems: 1, maxItemsPerWeek: 1 }, cadenceConstraints: { minimumHoursBetweenItems: 0, maxItemsPerChannelPerWeek: 1 }, maxConcurrentItems: 1 };
    const completed = { ref: { ...ref, id: "finished" }, channel: "x", scheduledFor: "2026-11-02T12:00:00Z", lifecycle: { status: "completed" as const } };
    expect(calendarConflicts({ ref, channel: "x", scheduledFor: "2026-11-09T12:00:00Z" }, [completed], policy)).toEqual([]);
    expect(calendarConflicts({ ref, channel: "x", scheduledFor: "2026-11-03T12:00:00Z" }, [completed], policy)).toEqual(["weekly production capacity exceeded", "channel weekly cadence exceeded"]);
  });
});
