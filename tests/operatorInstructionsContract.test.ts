import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { operatorInstructionContextSchema, sealOperatorInstructionContext } from "@/lib/operatorInstructions";

const context = sealOperatorInstructionContext({
  draftId: "a".repeat(64), revision: 3, originalOperatorBrief: "Create launch media.",
  answers: [
    { requestId: "turn-initial", message: "Create launch media." },
    { requestId: "turn-creative", message: "Feature a copper robot on midnight blue with amber highlights." },
    { requestId: "turn-outcome", message: "Drive qualified founders to join the waitlist.", resolvedField: "expectedOutcome" },
  ],
});

const python = resolve("agent/.venv/bin/python");
const script = "import json,sys; from harmonia_agent.operator_instructions import validate_operator_instruction_context; print(json.dumps(validate_operator_instruction_context(json.load(sys.stdin)), separators=(',', ':')))";

describe("operator instruction provenance contract", () => {
  it("round-trips the exact TypeScript intake context through the strict Python schema", () => {
    const serialized = execFileSync(python, ["-c", script], { cwd: resolve("agent"), input: JSON.stringify(context), encoding: "utf8" });
    expect(operatorInstructionContextSchema.parse(JSON.parse(serialized))).toEqual(context);
    expect(context.originalOperatorBrief).toBe("Create launch media.");
    expect(context.resolvedInstructions).toContain("copper robot on midnight blue with amber highlights");
    expect(context.resolvedInstructions).toContain("Drive qualified founders to join the waitlist");
    expect(context.answerTurnIds).toEqual(["turn-creative", "turn-outcome"]);
  });

  it("rejects changed or extra provenance instead of accepting an unsealed provider context", () => {
    expect(operatorInstructionContextSchema.safeParse({ ...context, answerTurnIds: ["turn-outcome"] }).success).toBe(false);
    const result = spawnSync(python, ["-c", script], { cwd: resolve("agent"), input: JSON.stringify({ ...context, undeclared: true }), encoding: "utf8" });
    expect(result.status).not.toBe(0);
  });
});
