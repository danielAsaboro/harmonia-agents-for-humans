import { expect, it } from "vitest";
import { validateDreamEvidence } from "../src/lib/residentAutonomy/runtime";
it("rejects dream conclusions citing evidence outside the sealed input", () => {
  expect(() => validateDreamEvidence({reflections:[{id:"r",evidence_refs:["invented"]}],hypotheses:[],experiments:[]},["allowed"])).toThrow(/evidence/);
});
it("rejects experiments disconnected from a validated hypothesis", () => {
  expect(() => validateDreamEvidence({reflections:[],hypotheses:[],experiments:[{id:"e",hypothesis_id:"unknown"}]},["allowed"])).toThrow(/hypothesis/);
});
it("accepts a connected evidence graph", () => {
  expect(() => validateDreamEvidence({reflections:[{id:"r",evidence_refs:["o"]}],hypotheses:[{id:"h",reflection_id:"r",evidence_refs:["o"],contradiction_refs:[]}],experiments:[{id:"e",hypothesis_id:"h"}]},["o"])).not.toThrow();
});
