import { describe, expect, it } from "vitest";
import { architectureDefinition } from "../src/lib/architecture/data";
import { applyPreset, createDefaultExplorerState, parseExplorerQuery, serializeExplorerQuery, toggleGroup } from "../src/lib/architecture/explorerState";

describe("architecture explorer state", () => {
  it("restores and normalizes valid URL state", () => {
    const state = parseExplorerQuery(new URLSearchParams("preset=agents&node=agent-nova&expanded=group-skills,bad&layers=agents,bad&q=Nova"), architectureDefinition);
    expect(state.presetId).toBe("agents");
    expect(state.selectedNodeId).toBe("agent-nova");
    expect(state.expanded).toContain("group-skills");
    expect(state.expanded).not.toContain("bad");
    expect(state.layers).toEqual(["agents"]);
    expect(serializeExplorerQuery(state).toString()).toContain("node=agent-nova");
  });

  it("applies presets and toggles groups without mutating prior state", () => {
    const initial = createDefaultExplorerState(architectureDefinition);
    const agents = applyPreset(initial, "agents", architectureDefinition);
    expect(agents.expanded).toContain("workflow-flo");
    const collapsed = toggleGroup(agents, "workflow-flo");
    expect(collapsed.expanded).not.toContain("workflow-flo");
    expect(agents.expanded).toContain("workflow-flo");
  });
});
