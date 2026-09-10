import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { editorialPlannerInputSchema } from "@/lib/contracts";
import { strategyRefSchema } from "@/lib/strategy/contracts";

describe("Python to TypeScript pinned strategy contract", () => {
  it("preserves the exact host reference and lifetime revision through actual Python JSON", () => {
    const serialized = JSON.parse(execFileSync(resolve("agent/.venv/bin/python"), ["-c", "from tests.test_temi_editorial_plan import planner_input\nfrom harmonia_agent.agent_models import EditorialPlannerInput\nvalue = planner_input()\nvalue['strategyRef']['revision'] = 37\nprint(EditorialPlannerInput.model_validate(value).model_dump_json(exclude_none=True))"], { cwd: resolve("agent"), encoding: "utf8" }));
    const input = editorialPlannerInputSchema.parse(serialized);
    expect(input.strategyRef.revision).toBe(37);
    expect(input.strategyRef.digest).toBe(input.strategyDigest);
    expect(editorialPlannerInputSchema.safeParse({ ...serialized, strategyRef: { ...serialized.strategyRef, digest: "0".repeat(64) } }).success).toBe(false);
    expect(strategyRefSchema.safeParse({ ...serialized.strategyRef, workspaceId: "../another" }).success).toBe(false);
  });
});
