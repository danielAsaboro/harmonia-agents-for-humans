import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

function fakeGcloudEnvironment() {
  const directory = mkdtempSync(join(tmpdir(), "harmonia-infra-test-"));
  const logPath = join(directory, "gcloud.log");
  const gcloudPath = join(directory, "gcloud");
  writeFileSync(
    gcloudPath,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GCLOUD_LOG"
case "$*" in
  *"storage buckets describe"*"format=value(location)"*) printf 'us-central1\\n' ;;
  *"firestore databases describe"*"format=value(locationId)"*) printf 'us-central1\\n' ;;
  *"run services describe harmonia-web"*) printf 'https://harmonia-web.example.run.app\\n' ;;
  *"run services describe harmonia-agent"*) printf 'https://harmonia-agent.example.run.app\\n' ;;
  *"projects describe"*) printf '166794945034\\n' ;;
esac
exit 0
`,
  );
  chmodSync(gcloudPath, 0o755);
  return {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      FAKE_GCLOUD_LOG: logPath,
      PROJECT_ID: "project-eabd3654-89fd-476d-b23",
      REGION: "us-central1",
      GOOGLE_CLIENT_ID: "calendar-client-id",
      GOOGLE_CLIENT_SECRET: "calendar-client-secret",
    },
    log: () => readFileSync(logPath, "utf8"),
  };
}

describe("Google Cloud deployment automation", () => {
  it("deploys a scale-to-zero web preview without paid agent resources", () => {
    const fake = fakeGcloudEnvironment();

    execFileSync("bash", ["infra/deploy-web-preview.sh"], {
      cwd: repoRoot,
      env: {
        ...fake.env,
        FIREBASE_API_KEY: "firebase-api-key",
        FIREBASE_APP_ID: "firebase-app-id",
      },
    });

    const log = fake.log();
    expect(log).toContain("run deploy harmonia-web");
    expect(log).toContain("--min-instances 0");
    expect(log).toContain("--max-instances 1");
    expect(log).toContain("--cpu-throttling");
    expect(log).toContain("HARMONIA_PREVIEW_MODE=1");
    expect(log).not.toContain("run deploy harmonia-agent");
    expect(log).not.toContain("GEMMA_VERTEX_ENDPOINT");
    expect(log).not.toContain("AGENT_ENGINE_RESOURCE");
    expect(log).not.toContain("GEMINI_API_KEY=");
    expect(log).not.toContain("pubsub subscriptions create");
  });

  it("provisions server-side Google OAuth credentials as managed secrets", () => {
    const fake = fakeGcloudEnvironment();

    execFileSync("bash", ["infra/setup.sh"], { cwd: repoRoot, env: fake.env });

    expect(fake.log()).toContain("secrets create google-oauth-client-id");
    expect(fake.log()).toContain("secrets create google-oauth-client-secret");
  });

  it("mounts Google OAuth secrets into the deployed web service", () => {
    const fake = fakeGcloudEnvironment();

    execFileSync("bash", ["infra/deploy.sh"], {
      cwd: repoRoot,
      env: {
        ...fake.env,
        FIREBASE_API_KEY: "firebase-api-key",
        FIREBASE_APP_ID: "firebase-app-id",
        GEMMA_VERTEX_ENDPOINT: "projects/p/locations/us-central1/endpoints/1",
        AGENT_ENGINE_RESOURCE: "projects/p/locations/us-central1/reasoningEngines/2",
      },
    });

    expect(fake.log()).toContain("GOOGLE_CLIENT_ID=google-oauth-client-id:latest");
    expect(fake.log()).toContain("GOOGLE_CLIENT_SECRET=google-oauth-client-secret:latest");
  });

  it("provisions durable media storage and authenticated Pub/Sub push authority", () => {
    const fake = fakeGcloudEnvironment();

    execFileSync("bash", ["infra/setup.sh"], { cwd: repoRoot, env: fake.env });

    expect(fake.log()).toContain("storage buckets describe gs://project-eabd3654-89fd-476d-b23-harmonia-assets");
    expect(fake.log()).toContain("storage buckets add-iam-policy-binding gs://project-eabd3654-89fd-476d-b23-harmonia-assets");
    expect(fake.log()).toContain("roles/storage.objectAdmin");
    expect(fake.log()).toContain("service-166794945034@gcp-sa-pubsub.iam.gserviceaccount.com");
    expect(fake.log()).toContain("roles/iam.serviceAccountTokenCreator");
  });

  it("injects durable media storage and configures its deployed web origin", () => {
    const fake = fakeGcloudEnvironment();

    execFileSync("bash", ["infra/deploy.sh"], {
      cwd: repoRoot,
      env: {
        ...fake.env,
        FIREBASE_API_KEY: "firebase-api-key",
        FIREBASE_APP_ID: "firebase-app-id",
        GEMMA_VERTEX_ENDPOINT: "projects/p/locations/us-central1/endpoints/1",
        AGENT_ENGINE_RESOURCE: "projects/p/locations/us-central1/reasoningEngines/2",
      },
    });

    expect(fake.log()).toContain("GCS_BUCKET=project-eabd3654-89fd-476d-b23-harmonia-assets");
    expect(fake.log()).toContain("storage buckets update gs://project-eabd3654-89fd-476d-b23-harmonia-assets");
    expect(fake.log()).toContain("--cors-file=");
  });
});
