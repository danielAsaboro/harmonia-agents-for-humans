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
      ELEVENLABS_MUSIC_COST_PER_SECOND_USD: "",
      NOVA_REEL_COST_PER_SECOND_USD: "",
    })).toMatchObject({
      ELEVENLABS_MUSIC_COST_PER_SECOND_USD: undefined,
      NOVA_REEL_COST_PER_SECOND_USD: undefined,
    });
  });

  it("preserves the explicit attachment origin allowlist", () => {
    expect(parseConfig({
      ...required,
      ATTACHMENT_ALLOWED_ORIGINS: "https://app.useharmonia.xyz,https://harmonia-web.example.run.app",
    })).toMatchObject({
      ATTACHMENT_ALLOWED_ORIGINS: "https://app.useharmonia.xyz,https://harmonia-web.example.run.app",
    });
  });
});
