import { describe, expect, it } from "vitest";
import { parseConfig } from "@/lib/config";

const required = {
  INTERNAL_API_TOKEN: "test-token",
  AGENT_SERVICE_URL: "https://agent.example.test",
};

describe("runtime configuration", () => {
  it("treats blank optional media prices as unavailable", () => {
    expect(parseConfig({
      ...required,
      LYRIA_3_CLIP_COST_USD: "",
      VEO_3_1_COST_PER_SECOND_USD: "",
    })).toMatchObject({
      LYRIA_3_CLIP_COST_USD: undefined,
      VEO_3_1_COST_PER_SECOND_USD: undefined,
    });
  });
});
