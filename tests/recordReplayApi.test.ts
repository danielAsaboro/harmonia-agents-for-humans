import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createReplaySession, getReplaySession } from "@/lib/recordReplay/sessionStore";
import { replayTestBundle } from "./recordReplayImporter.test";

describe("isolated replay sessions", () => {
  it("returns disclosure metadata and cursor events without live dependencies", () => {
    const session = createReplaySession(JSON.stringify(replayTestBundle()));
    expect(getReplaySession(session.id)?.metadata).toMatchObject({ executionMode: "recorded_replay", evidenceClassification: "historical_replay", bundleId: "bundle-1" });
    expect(session.dispatcher.eventsAfter(-1)).toHaveLength(1);
    for (const file of ["src/lib/recordReplay/sessionStore.ts", "src/app/api/replay/sessions/route.ts", "src/app/api/replay/sessions/[id]/events/route.ts", "src/app/api/replay/sessions/[id]/control/route.ts"]) {
      const source = readFileSync(file, "utf8"); expect(source).not.toMatch(/firestore|effectClaims|jobEffectCommands|oauth|publish/i);
    }
  });
});
