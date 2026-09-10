import { z } from "zod";
import { internalTenantHandler } from "@/lib/internalAuth";
import { sealDreamInput,reserveDream,persistDream,latestDream,persistWakeup,sealWakeupInput } from "@/lib/residentAutonomy/runtime";
const base={cycleId:z.string().min(1),claimToken:z.string().min(1)};
const input=z.discriminatedUnion("action",[
  z.object({action:z.literal("seal"),...base}).strict(),
  z.object({action:z.literal("reserve"),...base}).strict(),
  z.object({action:z.literal("persist"),...base,output:z.record(z.string(),z.unknown())}).strict(),
  z.object({action:z.literal("latest")}).strict(),
  z.object({action:z.literal("seal_wakeup"),...base}).strict(),
  z.object({action:z.literal("wakeup"),...base,briefing:z.string().min(1).max(8000),items:z.array(z.object({key:z.string(),title:z.string(),evidenceRefs:z.array(z.string()).min(1),authority:z.enum(["propose","request_attention"]),estimatedCostUsd:z.number().nonnegative(),deadline:z.string().datetime({offset:true}),risk:z.enum(["low","medium","high"])}).strict()).max(200)}).strict(),
]);
export const POST=internalTenantHandler(async req=>{
 const body=input.parse(await req.json());
 switch(body.action){
 case "seal":return Response.json(await sealDreamInput(body.cycleId,body.claimToken));
 case "reserve":return Response.json(await reserveDream(body.cycleId,body.claimToken));
 case "persist":return Response.json(await persistDream(body.cycleId,body.claimToken,body.output));
 case "seal_wakeup":return Response.json(await sealWakeupInput(body.cycleId,body.claimToken));
 case "latest":return Response.json({dream:await latestDream()});
 case "wakeup":return Response.json(await persistWakeup(body.cycleId,body.claimToken,body.briefing,body.items));
 }
});
