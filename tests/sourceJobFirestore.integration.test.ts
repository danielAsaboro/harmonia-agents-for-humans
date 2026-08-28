import { afterAll, describe, expect, it } from "vitest";

import { firebasePrincipal } from "@/lib/authority";
import { db, getJob } from "@/lib/firestore";
import { createSourceJob } from "@/lib/sourceManifest";
import { runWithTenant } from "@/lib/tenancy";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const workspaceId = `source-job-test-${Date.now()}`;
const scope = {
  workspaceId,
  brandId: "brand-test",
  principal: firebasePrincipal({ subjectId: "user-test", workspaceRole: "owner", authenticationId: "firebase-test" }),
};

describe.skipIf(!emulator)("source job Firestore persistence", () => {
  it("creates a source job when optional strategy inputs are absent", async () => {
    const job = await runWithTenant(scope, () => createSourceJob({
      directSources: [{
        kind: "web",
        url: "https://example.com",
        rightsAuthorizationId: "rights-web",
      }],
      desiredOutputs: ["linkedin_post"],
      platforms: ["linkedin"],
    }));

    const persisted = await runWithTenant(scope, () => getJob(job.id));
    expect(persisted?.config).toEqual({
      sourceManifestId: expect.any(String),
      desiredOutputs: ["linkedin_post"],
      allowedOutputs: ["linkedin_post"],
      platforms: ["linkedin"],
    });
  });

  afterAll(async () => {
    if (emulator) await db().recursiveDelete(db().doc(`workspaces/${workspaceId}`));
  });
});
