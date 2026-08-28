import { describe, expect, it } from "vitest";
import { isValidContext, mockContextAnswer } from "@/lib/contextAnswer";

describe("isValidContext", () => {
  it("accepts known kinds with ids", () => {
    expect(isValidContext({ kind: "job", id: "j1" })).toBe(true);
    expect(isValidContext({ kind: "content_item", id: "item-1" })).toBe(true);
    expect(isValidContext({ kind: "proposal", id: "prop-1" })).toBe(true);
  });

  it("rejects unknown kinds and missing ids", () => {
    expect(isValidContext({ kind: "receipt", id: "r1" })).toBe(false);
    expect(isValidContext({ kind: "job" })).toBe(false);
    expect(isValidContext(null)).toBe(false);
    expect(isValidContext("job")).toBe(false);
  });
});

const jobRecord = {
  id: "job-1",
  stage: "awaiting_approval",
  status: "waiting_for_approval",
  drafts: [{ id: "d1", platform: "x", text: "hi" }],
  actions: [{ id: "a1" }, { id: "a2" }],
  verifications: [{ verified: true }, { verified: false }],
};

const itemRecord = {
  id: "item-1",
  status: "scheduled",
  publishMode: "auto",
  platforms: ["x"],
  scheduledFor: "2026-08-25T10:30:00Z",
};

const proposalRecord = {
  id: "prop-1",
  source: "trend_scan",
  status: "proposed",
  topic: "Founder take on agents replacing tools",
  reason: "Front-page attention window right now",
};

describe("mockContextAnswer", () => {
  it("summarizes jobs from real fields only", () => {
    const answer = mockContextAnswer("what's the state?", jobRecord, "job");
    expect(answer).toContain("job-1");
    expect(answer).toContain("awaiting_approval");
    expect(answer).toContain("1 drafted post(s)");
    expect(answer).toContain("2 proposed action(s)");
    expect(answer).toContain("1/2 verifications");
  });

  it("handles missing arrays without crashing", () => {
    const answer = mockContextAnswer("state?", { id: "job-2", stage: "collect_sources", status: "running" }, "job");
    expect(answer).toContain("0 drafted post(s)");
    expect(answer).toContain("0/0 verifications");
  });

  it("summarizes content items", () => {
    const answer = mockContextAnswer("when does this go out?", itemRecord, "content_item");
    expect(answer).toContain("scheduled");
    expect(answer).toContain("auto");
    expect(answer).toContain("2026-08-25T10:30:00Z");
  });

  it("summarizes proposals with topic and reason", () => {
    const answer = mockContextAnswer("why this?", proposalRecord, "proposal");
    expect(answer).toContain("trend_scan");
    expect(answer).toContain("agents replacing tools");
    expect(answer).toContain("attention window");
  });
});
