import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe,expect,it } from "vitest";
const read=(p:string)=>readFileSync(new URL(`../${p}`,import.meta.url),"utf8");
describe("AWS deployment boundaries",()=>{
 it("refuses deployment and bootstrap before any AWS command without spend authorization",()=>{
   for(const script of ["infra/deploy.sh","infra/setup.sh","infra/build-cognition.sh"]){
     let failure: {status?:number;stderr?:unknown} | undefined;try{execFileSync("bash",[script],{env:{NODE_ENV:"test",PATH:process.env.PATH,HARMONIA_ALLOW_PAID_DEPLOYMENT:"false"},stdio:"pipe"});}catch(error){failure=error as {status?:number;stderr?:unknown};}
     expect(failure?.status).toBe(2);expect(String(failure?.stderr)).toMatch(/disabled/i);
   }
 });
 it("uses declarative CloudFormation changes and preserves IAM review",()=>{
   expect(read("infra/deploy.sh")).toContain("--require-approval broadening");
   expect(read("infra/setup.sh")).toContain("cdk bootstrap");
   expect(read("infra/deploy.sh")).not.toContain("gcloud");
 });
});
