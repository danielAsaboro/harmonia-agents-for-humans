import type { Stage } from "../types";
import { parseHarmoniaSurfacePart } from "./contracts";
import { jobProgressState } from "./jobProgress";

export function currentJobProgressParts(parts: unknown[], job: { id: string; stage: Stage; status: string }): unknown[] {
  return parts.map((input) => {
    const part = parseHarmoniaSurfacePart(input);
    return { ...part, data: { ...part.data, components: part.data.components.map((component) => {
      if (component.component !== "JobProgress") return component;
      if (component.jobId !== job.id) throw new Error("Generated progress belongs to a different job");
      return { ...component, ...jobProgressState(job) };
    }) } };
  });
}
