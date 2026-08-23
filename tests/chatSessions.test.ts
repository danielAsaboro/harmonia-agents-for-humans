import { describe, expect, it } from "vitest";
import { groupSessions } from "../src/lib/chatSessions";

describe("chat sessions", () => {
  it("keeps stable message IDs and run state inside grouped sessions", () => {
    const run = { runId: "r1", status: "complete" as const, lastSequence: 1, text: "Done", activities: [], tools: [], operations: [], confirmations: [], jobUpdates: [] };
    const sessions = groupSessions([
      { id: "m1", role: "user", text: "Create launch content", surface: "dashboard", at: "2026-08-23T08:00:00.000Z" },
      { id: "m2", role: "assistant", text: "Created", surface: "dashboard", at: "2026-08-23T08:00:01.000Z", run, data: { intent: "create_job", reply: "", jobId: "job-1" } },
    ]);
    expect(sessions[0].messages.map((message) => message.id)).toEqual(["m1", "m2"]);
    expect(sessions[0].messages[1].run?.runId).toBe("r1");
  });
});
