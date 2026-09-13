import { App } from "aws-cdk-lib";
import { HarmoniaAwsStack } from "./stack";
import { deploymentStackId, deploymentStage } from "./stage";
const app = new App();
const stage = deploymentStage(app.node.tryGetContext("stage"));
new HarmoniaAwsStack(app, deploymentStackId(stage), {env:{region:process.env.AWS_REGION || "us-east-1"}});
