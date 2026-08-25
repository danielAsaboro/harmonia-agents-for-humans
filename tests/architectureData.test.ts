import { describe, expect, it } from "vitest";
import { architectureDefinition } from "../src/lib/architecture/data";

const byId = (id: string) => architectureDefinition.nodes.find((node) => node.id === id)!;

describe("Harmonia architecture dataset", () => {
  it("contains the exact agent and model team", () => {
    expect(byId("agent-harmonia").model?.name).toBe("Gemini 3.5 Flash-Lite");
    expect(byId("agent-ryan").model?.name).toBe("Gemini 3.5 Flash");
    expect(byId("agent-nimi").model?.name).toBe("Gemini 3.5 Flash");
    expect(byId("agent-noni").model?.name).toBe("Gemma 3 12B IT");
    expect(byId("agent-dara").model?.name).toBe("Gemini 3.5 Flash");
    expect(byId("agent-temi").model?.name).toBe("Gemini 3.5 Flash-Lite");
    expect(byId("agent-maya").model?.name).toBe("Gemini 3.5 Flash");
    expect(byId("agent-nova").model?.name).toBe("Gemini 3.5 Flash");
  });

  it("contains the ten stages, five skills, and six read-only tools", () => {
    for (const id of ["ingest", "transcribe", "analyze", "strategize", "strategy-approval", "draft", "await-approval", "publish-render", "verify", "learn"]) expect(byId(`stage-${id}`)).toBeTruthy();
    for (const id of ["trend-scan", "signal-watch", "engagement-insights", "job-status", "posting-schedule"]) expect(byId(`skill-${id}`)).toBeTruthy();
    for (const id of ["fetch-trend-signals", "search-trend-signals", "get-engagement-insights", "get-operator-feed", "get-job-status", "suggest-posting-windows"]) {
      expect(byId(`tool-${id}`).authorities).toEqual(["read"]);
    }
  });

  it("keeps durable and ephemeral state ownership explicit", () => {
    expect(byId("firestore").stateLifetime).toBe("durable");
    expect(byId("agent-engine").stateLifetime).toBe("ephemeral");
    expect(byId("agent-engine").summary).toMatch(/cognitive runtime/i);
  });

  it("does not claim pending providers are live verified", () => {
    for (const id of ["external-veo", "external-lyria", "agent-engine", "memory-bank"]) {
      expect(byId(id).statuses).toContain("pending-live");
      expect(byId(id).statuses).not.toContain("offline-verified");
    }
  });

  it("defines all required explorer presets", () => {
    expect(architectureDefinition.presets.map((preset) => preset.id)).toEqual([
      "overview", "agents", "workflow", "effect-safety", "state", "apis", "observability",
    ]);
  });
});
