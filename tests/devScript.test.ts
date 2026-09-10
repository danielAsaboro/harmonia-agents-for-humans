import { readFileSync } from "node:fs";
import { expect,it } from "vitest";
it("local startup requires real identity and opts out of paid work",()=>{
 const script=readFileSync(new URL("../scripts/dev.sh",import.meta.url),"utf8");
 expect(script).toContain("COGNITO_USER_POOL_ID:?");
 expect(script).toContain("HARMONIA_ALLOW_PAID_AWS:-false");
 expect(script).not.toContain("gcloud");
 expect(script).not.toContain("kill 0");
});
