import { strategyDigest } from "../strategyApproval";
import { pinnedMeasurementSchema, type Evaluation, type PerformanceObservation } from "./contracts";

/** Only identical definitions and strategy revisions are comparable. Counts are descriptive, never causal. */
export function evaluateObservations(observations: PerformanceObservation[]): Evaluation {
  if (!observations.length) throw new Error("observations required");
  const first = observations[0];
  for (const o of observations) {
    if (!pinnedMeasurementSchema.safeParse(o.measurement).success) throw new Error("incompatible measurement definition digest");
    if (o.kind === "performance" && Date.parse(o.window.endAt) - Date.parse(o.window.startAt) !== o.measurement.definition.window.endOffsetSeconds * 1000) throw new Error("incompatible observation window");
  }
  const signature = (o: PerformanceObservation) => strategyDigest({ definition: o.measurement, strategyRef: o.strategyRef, kind: o.kind });
  if (observations.some(o => signature(o) !== signature(first))) throw new Error("incompatible metric, unit, window, definition or strategy revision");
  const unique = [...new Map(observations.map(o => [o.id, o])).values()];
  const measured = unique.filter(o => o.availability === "available" && o.value !== null);
  if (new Set(measured.map(o => strategyDigest(o.itemRef))).size !== measured.length) throw new Error("incompatible repeated item samples");
  const m = first.measurement.definition;
  const support = measured.filter(o => m.comparator === "gte" ? o.value! >= m.target! : m.comparator === "lte" ? o.value! <= m.target! : m.comparator === "eq" ? o.value === m.target : false);
  const contradictions = m.comparator === "observe" ? [] : measured.filter(o => !support.includes(o));
  const limitations = ["Observational association cannot establish causation or a winning pattern.", "Collection timing is bounded by the pinned window tolerance."];
  if (measured.length < 2) limitations.push("A single post or no measured posts cannot establish a repeatable pattern.");
  if (measured.length < unique.length) limitations.push("Missing, pending, failed and revoked observations are excluded, never treated as zero.");
  if (first.kind === "delivery_verification") limitations.push("Delivery verification proves an effect receipt only; it does not prove audience or business success.");
  const refs = <T>(items: T[]) => [...new Map(items.map(item => [strategyDigest(item), item])).values()];
  return { id: `evaluation-${strategyDigest(unique.map(o => o.id).sort()).slice(0, 48)}`, observationIds: unique.map(o => o.id), measurement: first.measurement, strategyRef: first.strategyRef,
    campaignRefs: refs(unique.flatMap(o => o.campaignRef ? [o.campaignRef] : [])), planRefs: refs(unique.map(o => o.planRef)), itemRefs: refs(unique.map(o => o.itemRef)), pillars: [...new Set(unique.flatMap(o => o.pillar ? [o.pillar] : []))],
    sampleCount: measured.length, value: measured.length ? measured.reduce((sum, o) => sum + o.value!, 0) / measured.length : null,
    cohortCount: unique.length, missingCounts: { pending_window: unique.filter(o => o.availability === "pending_window").length, unavailable: unique.filter(o => o.availability === "unavailable").length, failed: unique.filter(o => o.availability === "failed").length, revoked: unique.filter(o => o.availability === "revoked").length },
    baseline: m.baseline, supportingObservationIds: support.map(o => o.id), contradictingObservationIds: contradictions.map(o => o.id),
    confidence: measured.length === 0 ? "insufficient" : measured.length < 5 || contradictions.length > 0 ? "low" : "moderate", causalClaim: false,
    outcome: first.kind === "delivery_verification" ? "delivery_only" : measured.length ? "observational" : "unmeasured", limitations };
}
export function aggregateCompatibleObservations(observations: PerformanceObservation[], groupBy: "strategy" | "campaign" | "pillar") {
  const groups = new Map<string, PerformanceObservation[]>();
  for (const observation of observations) {
    if (groupBy === "campaign" && !observation.campaignRef) continue;
    if (groupBy === "pillar" && !observation.pillar) continue;
    const groupKey = groupBy === "campaign" ? strategyDigest(observation.campaignRef) : groupBy === "pillar" ? observation.pillar! : strategyDigest(observation.strategyRef);
    const key = strategyDigest([observation.strategyRef, groupKey]);
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }
  return [...groups].map(([groupKey, observations]) => ({ groupBy, groupKey, evaluation: evaluateObservations(observations) }));
}
