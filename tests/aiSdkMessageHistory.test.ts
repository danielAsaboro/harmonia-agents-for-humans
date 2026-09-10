import { describe, expect, it } from "vitest";
import { validatePersistedHarmoniaMessages } from "../src/lib/ai-sdk/messageHistory";

describe("persisted AI SDK message validation", () => {
  it("accepts typed history and rejects unregistered surface components", async () => {
    const base = { id: "assistant-1", role: "assistant", parts: [{ type: "data-harmonia-surface", id: "surface-1", data: { surfaceId: "surface-1", slot: "canvas", revision: 1, components: [{ id: "root", component: "Column", children: [] }] } }] };
    await expect(validatePersistedHarmoniaMessages([base])).resolves.toHaveLength(1);
    await expect(validatePersistedHarmoniaMessages([{ ...base, parts: [{ ...base.parts[0], data: { ...base.parts[0].data, components: [{ id: "root", component: "ArbitraryHtml", html: "<script/>" }] } }] }])).rejects.toThrow();
  });
});
