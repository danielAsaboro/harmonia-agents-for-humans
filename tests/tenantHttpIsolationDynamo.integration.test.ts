import { createHash } from "node:crypto";
import {
  createSessionCookie,
  requireTenantContext,
  revokeSession,
} from "@/lib/auth";
vi.mock("@/lib/cognito", () => ({
  cognitoSettings: () => ({
    domain: "https://identity.example.test",
    clientId: "test-client",
  }),
  verifyCognitoIdentity: async () => ({
    uid: "cognito-test-user",
    email: "test@example.test",
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
}));
import { awsRepository, recordKey, partition, field } from "../src/lib/dynamo";
import { afterAll, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/jobs/[id]/route";
import { db } from "@/lib/repository";

const emulator = process.env.AWS_LOCAL_ENDPOINT;
const foreignWorkspaceId = "http-isolation-foreign";
const jobId = "shared-http-job";
let authenticatedWorkspaceId = "";
let cookie = "";

function request(workspaceOverride: string): Request {
  return new Request(`http://localhost/api/jobs/${jobId}`, {
    headers: {
      cookie,
      "x-workspace-id": workspaceOverride,
      "x-brand-id": "caller-controlled-brand",
    },
  });
}

function routeArgs() {
  return { params: Promise.resolve({ id: jobId }) };
}

function job(workspaceId: string, brandId: string) {
  const now = "2026-08-30T15:00:00.000Z";
  return {
    id: jobId,
    workspaceId,
    brandId,
    createdByUserId: "operator",
    createdAt: now,
    updatedAt: now,
    status: "running",
    stage: "draft",
    config: {
      sourceManifestId: "manifest-1",
      desiredOutputs: ["x_post"],
      allowedOutputs: ["x_post"],
      platforms: ["x"],
    },
    actions: [],
  };
}

describe.skipIf(!emulator)("HTTP tenant isolation", () => {
  it("ignores caller-controlled tenant headers and reads only the authenticated workspace", async () => {
    cookie = (await createSessionCookie("test-verified-identity")).split(
      ";",
    )[0];
    await awsRepository().put(
      recordKey(`workspaces/${foreignWorkspaceId}/jobs/${jobId}`),
      job(foreignWorkspaceId, "foreign-brand"),
    );

    await expect(GET(request(foreignWorkspaceId), routeArgs())).rejects.toThrow(
      "job not found",
    );

    const user = await awsRepository().read(
      recordKey(partition("users").partition + "/" + "cognito-test-user"),
    );
    authenticatedWorkspaceId = field(
      user.value,
      "defaultWorkspaceId",
    ) as string;
    const authenticatedBrandId = field(user.value, "defaultBrandId") as string;
    expect(authenticatedWorkspaceId).toBeTruthy();
    expect(authenticatedWorkspaceId).not.toBe(foreignWorkspaceId);

    await awsRepository().put(
      recordKey(`workspaces/${authenticatedWorkspaceId}/jobs/${jobId}`),
      job(authenticatedWorkspaceId, authenticatedBrandId),
    );

    const response = await GET(request(foreignWorkspaceId), routeArgs());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.job).toMatchObject({
      id: jobId,
      workspaceId: authenticatedWorkspaceId,
    });
    expect(body.job.workspaceId).not.toBe(foreignWorkspaceId);
  });

  it("refreshes an encrypted session and prevents refresh from recreating a revoked session", async () => {
    vi.stubEnv(
      "HARMONIA_CONNECTION_ENVELOPE_KEY_RAW",
      "01234567890123456789012345678901",
    );
    cookie = (
      await createSessionCookie("old-id-token", "private-refresh-token")
    ).split(";")[0];
    const sessionKey = recordKey(
      "sessions/" +
        createHash("sha256").update(cookie.split("=")[1]).digest("hex"),
    );
    const stored = await awsRepository().read(sessionKey);
    expect(JSON.stringify(stored.value?.refreshToken)).not.toContain(
      "private-refresh-token",
    );
    await awsRepository().patch(sessionKey, { tokenExpiresAt: Date.now() - 1 });
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ id_token: "fresh-id-token" }));
    await requireTenantContext(request(foreignWorkspaceId));
    expect((await awsRepository().read(sessionKey)).value?.idToken).toBe(
      "fresh-id-token",
    );
    await awsRepository().patch(sessionKey, { tokenExpiresAt: Date.now() - 1 });
    fetcher.mockImplementation(async () => {
      await revokeSession(request(foreignWorkspaceId));
      return Response.json({ id_token: "late-id-token" });
    });
    await expect(
      requireTenantContext(request(foreignWorkspaceId)),
    ).rejects.toThrow("session was revoked");
    expect((await awsRepository().read(sessionKey)).present).toBe(false);
    fetcher.mockRestore();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (!emulator) return;
    await db().removeTree(recordKey(`workspaces/${foreignWorkspaceId}`));
    if (authenticatedWorkspaceId) {
      await db().removeTree(
        recordKey(`workspaces/${authenticatedWorkspaceId}`),
      );
    }
    await awsRepository().remove(
      recordKey(partition("users").partition + "/" + "cognito-test-user"),
    );
  });
});
