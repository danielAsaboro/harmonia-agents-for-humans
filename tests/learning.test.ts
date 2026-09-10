import { describe, expect, it } from "vitest";

describe("measurement learning authority", () => {
  it("pins typed definitions and rejects unavailable numeric values", async () => {
    const contracts = await import("@/lib/learning/contracts").catch(() => null);
    expect(contracts, "measurement authority contract must exist").not.toBeNull();
    const definitions = contracts!.defaultMeasurements("x");
    expect(definitions.map(d => d.definition.metricId)).toEqual(["delivery.verified", "x.likes"]);
    expect(definitions[1].definition.window.endOffsetSeconds).toBe(86400);
    expect(contracts!.observationValueSchema.safeParse({ availability: "unavailable", value: 0, reason: "missing" }).success).toBe(false);
    expect(contracts!.observationValueSchema.safeParse({ availability: "unavailable", value: null, reason: "missing" }).success).toBe(true);
  });
  it("refuses incompatible aggregation and preserves contradictions without causal claims", async () => {
    const evaluation = await import("@/lib/learning/evaluation").catch(() => null);
    expect(evaluation, "compatible evaluation must exist").not.toBeNull();
    const { defaultMeasurements, pinMeasurement } = await import("@/lib/learning/contracts");
    const definition = defaultMeasurements("x")[1];
    const observation = (id: string, value: number | null, availability = "available") => ({ id, measurement: definition, kind: "performance", availability, value, itemRef: { id, revision: 1 }, planRef: { id: "plan", revision: 1 }, campaignRef: null, strategyRef: { digest: "a" }, window: { startAt: "2026-09-01T00:00:00Z", endAt: "2026-09-02T00:00:00Z" }, sourceIds: [], evidenceRefs: [] });
    const pending = evaluation!.evaluateObservations([observation("one", null, "pending_window")] as never);
    expect(pending).toMatchObject({ sampleCount: 0, value: null, confidence: "insufficient", causalClaim: false });
    const cohort = evaluation!.evaluateObservations([observation("one", 3), observation("two", null, "unavailable"), observation("three", null, "pending_window")] as never);
    expect(cohort).toMatchObject({ sampleCount: 1, cohortCount: 3, missingCounts: { unavailable: 1, pending_window: 1, failed: 0, revoked: 0 } });
    const one = evaluation!.evaluateObservations([observation("one", 3)] as never);
    expect(one).toMatchObject({ sampleCount: 1, confidence: "low", causalClaim: false });
    expect(one.limitations.join(" ")).toContain("single");
    const target = pinMeasurement({ ...definition.definition, target: 5, comparator: "gte" });
    const conflict = evaluation!.evaluateObservations([{ ...observation("one", 7), measurement: target }, { ...observation("two", 2), measurement: target }] as never);
    expect(conflict.supportingObservationIds).toEqual(["one"]); expect(conflict.contradictingObservationIds).toEqual(["two"]);
    expect(() => evaluation!.evaluateObservations([observation("one", 7), { ...observation("two", 2), measurement: { ...definition, definition: { ...definition.definition, unit: "ratio" } } }] as never)).toThrow("incompatible");
    const delivery = evaluation!.evaluateObservations([{ ...observation("one", 1), kind: "delivery_verification", measurement: defaultMeasurements("x")[0] }] as never);
    expect(delivery).toMatchObject({ outcome: "delivery_only", causalClaim: false });
    expect(defaultMeasurements("linkedin")[1].definition.collectionMethod).toBe("unsupported");
    const groups = evaluation!.aggregateCompatibleObservations([observation("one", 7), observation("two", 2)] as never, "campaign");
    expect(groups).toEqual([]);
    const pillars = evaluation!.aggregateCompatibleObservations([{ ...observation("one", 7), pillar: "proof" }, { ...observation("two", 2), pillar: "story" }] as never, "pillar");
    expect(pillars.map(g => g.evaluation.sampleCount)).toEqual([1, 1]);
    expect(() => evaluation!.evaluateObservations([{ ...observation("one", 7), window: { startAt: "2026-09-01T00:00:00Z", endAt: "2026-09-03T00:00:00Z" } }] as never)).toThrow("window");
  });
});
