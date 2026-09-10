import { expect, it, vi } from "vitest";
import { brandLibraryConnectionSchema } from "@/lib/brandLibraries/contracts";
const state = vi.hoisted(() => ({ update: {} as Record<string, unknown> }));
vi.mock("@/lib/tenancy", () => ({ currentTenant: () => ({ workspaceId: "ws", brandId: "brand" }) }));
vi.mock("@/lib/dynamo", async importOriginal => {
  const original=await importOriginal<typeof import("@/lib/dynamo")>();
  return {...original,awsRepository:()=>({read:async()=>({present:true,value:{revision:1}}),patch:async(valueKey:unknown,value:Record<string,unknown>)=>{void valueKey;state.update=value;}})};
});
import { failLibrarySync } from "@/lib/brandLibraries/repository";

it("persists permanent failures using the readable connection status contract", async () => {
  await failLibrarySync("library", 1, { category: "permanent", retryCount: 1 });
  expect(brandLibraryConnectionSchema.shape.lastSyncStatus.parse(state.update.lastSyncStatus)).toBe("permanent_failure");
});
