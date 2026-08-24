import { describe, expect, it } from "vitest";

import { resolveDecision } from "@/lib/decisions";

describe("approval authority", () => {
  it.each(["system", "agent"] as const)("rejects %s as an approval actor before storage or effects", async (actor) => {
    await expect(resolveDecision("job-1", "action-1", "approved", actor)).rejects.toThrow(
      "only a human operator",
    );
  });
});
