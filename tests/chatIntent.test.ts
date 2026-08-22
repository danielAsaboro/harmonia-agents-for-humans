import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseIntent } from "@/lib/chatIntent";

describe("parseIntent (HARMONIA_MOCK_AI=1)", () => {
  beforeEach(() => {
    process.env.HARMONIA_MOCK_AI = "1";
  });
  afterEach(() => {
    delete process.env.HARMONIA_MOCK_AI;
  });

  it("routes youtube urls to create_job", async () => {
    expect(await parseIntent("make a job from https://youtu.be/jNQXAC9IVRw please"))
      .toMatchObject({ intent: "create_job", youtubeUrl: "https://youtu.be/jNQXAC9IVRw" });
    expect(await parseIntent("https://www.youtube.com/watch?v=dQw4w9WgXcQ"))
      .toMatchObject({ intent: "create_job", youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  });

  it("detects approve with optional job id", async () => {
    expect(await parseIntent("approve")).toEqual({ intent: "approve" });
    expect(await parseIntent("approve job demo-launch")).toMatchObject({
      intent: "approve",
      jobId: "demo-launch",
    });
  });

  it("detects drafts and status intents", async () => {
    expect(await parseIntent("show drafts for demo-clips")).toMatchObject({
      intent: "list_drafts", jobId: "demo-clips",
    });
    expect(await parseIntent("status")).toEqual({ intent: "status" });
    expect(await parseIntent("what's the status of job demo-podcast?")).toMatchObject({
      intent: "status", jobId: "demo-podcast",
    });
  });

  it("treats longer topic text as a brief job", async () => {
    const res = await parseIntent("Announce our usage-based billing launch for AI agent workloads today");
    expect(res.intent).toBe("create_job");
    expect(res.topic?.length).toBeGreaterThanOrEqual(20);
    expect(res.topic).not.toMatch(/^announce our usage-based billing launch/i);
  });

  it("returns unknown for short smalltalk", async () => {
    expect(await parseIntent("hello there")).toEqual({ intent: "unknown" });
  });

  it("never touches the network even without an api key", async () => {
    const key = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const res = await parseIntent("status");
      expect(res.intent).toBe("status");
    } finally {
      if (key !== undefined) process.env.GEMINI_API_KEY = key;
    }
  });
});
