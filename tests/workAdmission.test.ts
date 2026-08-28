import { describe, expect, it } from "vitest";

import { decideWorkAdmission } from "@/lib/operations/workAdmission";

describe("cooperative work admission", () => {
  it("admits new stage and effect work only while the job desires execution", () => {
    expect(decideWorkAdmission("run")).toEqual({ outcome: "execute" });
    expect(decideWorkAdmission("pause_requested")).toEqual({ outcome: "paused" });
    expect(decideWorkAdmission("cancel_requested")).toEqual({ outcome: "cancelled" });
  });
});
