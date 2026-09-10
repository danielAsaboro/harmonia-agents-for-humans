import { describe, expect, it } from "vitest";
import { replayChatRunEvents } from "../src/lib/ai-sdk/messageReducer";

describe("replayChatRunEvents", () => {
  it("reconstructs persisted UI state through the validated stream reducer", () => {
    const state = replayChatRunEvents("demo-run", [
      { type: "run_started", runId: "demo-run", sequence: 0, startedAt: "2026-08-23T08:00:00.000Z" },
      { type: "activity", runId: "demo-run", sequence: 1, activity: { id: "analyst", label: "Analyze source", status: "complete" } },
      { type: "tool_activity", runId: "demo-run", sequence: 2, tool: { name: "video_understanding", status: "complete", traceId: "trace-demo" } },
      { type: "ui_message_chunk", runId: "demo-run", sequence: 3, chunk: { version: "v0.9", createSurface: { surfaceId: "chat-demo-run", catalogId: "https://harmonia.app/ai-sdk/catalogs/chat/v1" } } },
      { type: "confirmation_requested", runId: "demo-run", sequence: 4, confirmation: { id: "approve-launch", jobId: "demo-launch", actionId: "act-pub-launch", title: "Publish launch post", risk: "high", state: "pending" } },
      { type: "run_completed", runId: "demo-run", sequence: 5, completedAt: "2026-08-23T08:00:05.000Z", reply: "Ready for review." },
    ]);

    expect(state).toMatchObject({
      runId: "demo-run",
      status: "complete",
      lastSequence: 5,
      text: "Ready for review.",
    });
    expect(state.activities).toHaveLength(1);
    expect(state.tools).toHaveLength(1);
    expect(state.parts).toHaveLength(1);
    expect(state.confirmations).toHaveLength(1);
  });

  it("rejects malformed or cross-run persisted events", () => {
    expect(() => replayChatRunEvents("demo-run", [
      { type: "activity", runId: "another-run", sequence: 0, activity: { id: "analyst", label: "Analyze source", status: "complete" } },
    ])).toThrow(/another-run/);

    expect(() => replayChatRunEvents("demo-run", [
      { type: "activity", runId: "demo-run", sequence: 0, activity: { id: "analyst", label: "Analyze source", status: "unknown" } },
    ])).toThrow();
  });

  it("preserves exact generated slot revisions in persisted order", () => {
    const parts = [
      { type: "data-harmonia-surface", id: "studio-demo-run-canvas-r1", data: { surfaceId: "studio-demo-run-canvas-r1", slot: "canvas", revision: 1, components: [{ id: "root", component: "Column", children: [] }] } },
      { type: "data-harmonia-surface", id: "studio-demo-run-conversation-r1", data: { surfaceId: "studio-demo-run-conversation-r1", slot: "conversation", revision: 1, components: [{ id: "root", component: "Column", children: [] }] } },
    ];
    const events = [
      { type: "run_started", runId: "demo-run", sequence: 0, startedAt: "2026-08-23T08:00:00.000Z" },
      ...parts.map((chunk, index) => ({ type: "ui_message_chunk", runId: "demo-run", sequence: index + 1, chunk })),
      { type: "run_completed", runId: "demo-run", sequence: parts.length + 1, completedAt: "2026-08-23T08:00:05.000Z", reply: "Ready." },
    ];
    expect(replayChatRunEvents("demo-run", events).parts).toEqual(parts);
  });

  it("rejects duplicate durable event sequences", () => {
    expect(() => replayChatRunEvents("demo-run", [
      { type: "run_started", runId: "demo-run", sequence: 0, startedAt: "2026-08-23T08:00:00.000Z" },
      { type: "text_delta", runId: "demo-run", sequence: 0, delta: "duplicate" },
    ])).toThrow("sequence");
  });
});
