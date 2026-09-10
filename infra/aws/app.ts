import { App } from "aws-cdk-lib";
import { HarmoniaAwsStack } from "./stack";
const app = new App();
new HarmoniaAwsStack(app,"HarmoniaStrands",{env:{region:process.env.AWS_REGION || "us-east-1"}});
