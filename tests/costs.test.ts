import { describe, expect, it } from "vitest";
import {
  applyFinalizedUsage,
  applyReservation,
  canReserve,
  summarizeUsage,
} from "@/lib/costs";
import type { JobBudget } from "@/lib/types";

const budget: JobBudget = {
  estimatedUsd: "0.20",
  observedUsd: "0.10",
  reservedUsd: "0.10",
  limitUsd: "0.30",
  approvalThresholdUsd: "0.20",
};

describe("job budgets", () => {
  it("rejects a reservation above the remaining limit", () => {
    expect(canReserve(budget, "0.11")).toBe(false);
  });

  it("reserves and finalizes usage without binary rounding drift", () => {
    const reserved = applyReservation(
      { ...budget, observedUsd: "0.00", reservedUsd: "0.00", estimatedUsd: "0.00" },
      "0.11",
    );
    expect(reserved).toMatchObject({ estimatedUsd: "0.11", reservedUsd: "0.11" });

    const finalized = applyFinalizedUsage(reserved, "0.11", "0.105001");
    expect(finalized).toMatchObject({ reservedUsd: "0.00", observedUsd: "0.105001" });
  });

  it("aggregates decimal strings by model", () => {
    expect(summarizeUsage([
      { model: "m1", estimatedCostUsd: "0.10" },
      { model: "m1", estimatedCostUsd: "0.20" },
      { model: "m2", estimatedCostUsd: "0.005001" },
    ])).toEqual({
      totalEstimatedUsd: "0.305001",
      byModel: { m1: "0.30", m2: "0.005001" },
    });
  });
});
