export type DeploymentStage = "staging" | "production";

export function deploymentStage(value: unknown): DeploymentStage {
  const stage = String(value ?? "staging");
  if (stage !== "staging" && stage !== "production") {
    throw new Error(`stage must be staging or production, received ${stage}`);
  }
  return stage;
}

export function deploymentStackId(stage: DeploymentStage): string {
  return stage === "production" ? "HarmoniaStrandsProduction" : "HarmoniaStrandsStaging";
}
