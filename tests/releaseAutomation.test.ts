import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("release and operations automation", () => {
  it("defines one exact-SHA release verification gate without deployment side effects", () => {
    const script = read("scripts/release-verify.sh");
    for (const command of [
      "git diff --check",
      "npm test",
      "npm run test:integration",
      "npm run test:agent",
      "npm run lint",
      "npx tsc --noEmit",
      "npm run build",
      "npm run infra:synth",
      "npm audit --omit=dev",
      "pip_audit",
      "npm run security:sbom",
    ]) expect(script).toContain(command);
    expect(script).toContain("git rev-parse HEAD");
    expect(script).toContain("git status --porcelain");
    expect(script).not.toMatch(/cdk deploy|docker push|git push/);
  });

  it("keeps image scanning local and blocks accidental remote targets", () => {
    const script = read("scripts/scan-release-images.sh");
    expect(script).toContain("names=(web worker cognition scanner)");
    expect(script).toContain("agent/Dockerfile agent/Dockerfile.agentcore");
    expect(script).toContain("docker scout cves");
    expect(script).toContain("--exit-code");
    expect(script).toContain("--only-severity critical,high");
    expect(script).toContain("scan_failed=false");
    expect(script).toContain("docker image inspect --format='{{json .Id}}'");
    expect(script).toContain('if [[ "$scan_failed" == true ]]');
    expect(script).not.toMatch(/--push|docker push/);
  });

  it("deletes only the controlled emulator run directory after integration", () => {
    const script = read("scripts/test-dynamo-integration.sh");
    expect(script).toContain('mktemp -d "${TMPDIR:-/tmp}/harmonia-dynamo.XXXXXX"');
    expect(script).toContain('rm -rf -- "$run_dir"');
    expect(script.indexOf('kill "$java_pid"')).toBeLessThan(script.indexOf('rm -rf -- "$run_dir"'));
  });

  it("pins every release image base and the source-built YouTube token provider", () => {
    for (const path of ["Dockerfile", "agent/Dockerfile", "agent/Dockerfile.agentcore", "infra/malware-scanner/Dockerfile"]) {
      const bases = read(path).split("\n").filter((line) => line.startsWith("FROM "));
      expect(bases.length).toBeGreaterThan(0);
      expect(bases.every((line) => /@sha256:[a-f0-9]{64}(?:\s|$)/.test(line)), `${path} has an unpinned base`).toBe(true);
    }
    expect(read("agent/Dockerfile")).toContain("7608dd51ee813b48cf9a6d68c6e42cb197ce10e0");
    const scanner = read("infra/malware-scanner/Dockerfile");
    expect(scanner).toContain("freshclam --quiet");
    expect(scanner).toContain("USER clamav");
    expect(scanner).toContain("freshclam --quiet && exec python");
  });

  it("requires two explicit approvals before any secret rotation command", () => {
    const script = read("infra/rotate-service-secrets.sh");
    expect(script.indexOf("HARMONIA_ALLOW_PAID_DEPLOYMENT")).toBeLessThan(script.indexOf("aws "));
    expect(script.indexOf("HARMONIA_APPROVE_SECRET_ROTATION")).toBeLessThan(script.indexOf("aws "));
    expect(script).toContain("get-random-password");
    expect(script).toContain("force-new-deployment");
    expect(script).toContain("update-agent-runtime");
    expect(script).toContain("get-agent-runtime");
    for (const field of [
      "authorizerConfiguration",
      "requestHeaderConfiguration",
      "lifecycleConfiguration",
      "metadataConfiguration",
      "filesystemConfigurations",
    ]) expect(script).toContain(field);

    let failure: { status?: number; stderr?: unknown } | undefined;
    try {
      execFileSync("bash", ["infra/rotate-service-secrets.sh"], {
        env: { NODE_ENV: "test", PATH: process.env.PATH, HARMONIA_ALLOW_PAID_DEPLOYMENT: "false" },
        stdio: "pipe",
      });
    } catch (error) {
      failure = error as { status?: number; stderr?: unknown };
    }
    expect(failure?.status).toBe(2);
    expect(String(failure?.stderr)).toMatch(/disabled/i);
  });

  it("synthesizes the same explicit stage arguments that deployment will use", () => {
    const script = read("infra/deploy.sh");
    expect(script).toContain('./node_modules/.bin/cdk synth --no-lookups "$@"');
    expect(script.indexOf('./node_modules/.bin/cdk synth --no-lookups "$@"')).toBeLessThan(script.indexOf("cdk deploy"));
  });

  it("provides manually approved staging and release-candidate workflows", () => {
    const staging = read(".github/workflows/staging.yml");
    const release = read(".github/workflows/release-candidate.yml");
    expect(staging).toContain("workflow_dispatch:");
    expect(staging).toContain("agentcore_image_uri:");
    expect(staging).toContain("required: true");
    expect(staging).toContain("environment: staging");
    expect(staging).toContain("id-token: write");
    expect(staging).toContain("infra/deploy.sh");
    expect(release).toContain("workflow_dispatch:");
    expect(release).toContain("docker/scout-action@481412c8b8de36d0f79e85aa382c60397466feb6");
    expect(release).toContain("docker image inspect --format='{{json .Id}}'");
    for (const image of ["web", "worker", "cognition", "scanner"]) expect(release).toContain(`name: ${image}`);
    expect(release).not.toContain("docker push");
    expect(staging).toContain('node-version: "22"');
    expect(release).toContain('node-version: "22"');
  });

  it("pins every first-party and third-party workflow action to an immutable commit", () => {
    for (const path of [
      ".github/workflows/verify.yml",
      ".github/workflows/release-candidate.yml",
      ".github/workflows/staging.yml",
    ]) {
      const useLines = read(path).split("\n").filter((line) => /^-?\s*uses:/.test(line.trimStart()));
      expect(useLines.length, `${path} has no action steps`).toBeGreaterThan(0);
      expect(useLines.every((line) => /@[a-f0-9]{40}(?:\s+#.*)?$/.test(line)), `${path} contains a mutable action reference`).toBe(true);
    }
  });

  it("keeps restore mutation isolated and separately approved", () => {
    const script = read("infra/restore-drill.sh");
    expect(script.indexOf("HARMONIA_ALLOW_PAID_DEPLOYMENT")).toBeLessThan(script.indexOf("aws "));
    expect(script.indexOf("HARMONIA_APPROVE_RESTORE_DRILL")).toBeLessThan(script.indexOf("aws "));
    expect(script).toContain("start-restore-job");
    expect(script).toContain("describe-restore-job");
    expect(script).toContain("describe-table");
    expect(script).toContain("HARMONIA_STAGE");
    expect(script.indexOf("Required stack output is missing")).toBeLessThan(script.indexOf("list-recovery-points-by-resource"));
    expect(script).not.toContain("delete-table");
  });

  it("runs security-boundary and emulator failure drills without provider calls", () => {
    const script = read("scripts/run-production-boundary-drills.sh");
    expect(script).toContain("attachmentOriginPolicy.test.ts");
    expect(script).toContain("telegramWebhook.test.ts");
    expect(script).toContain("tenantHttpIsolationDynamo.integration.test.ts");
    expect(script).toContain("npm run test:integration");
    expect(script).not.toMatch(/bedrock|cdk deploy|aws /);
  });

  it("checksum-verifies pinned local emulator artifacts", () => {
    const script = read("scripts/install-local-emulators.sh");
    expect(script).toContain("dynamodb_local_latest.tar.gz.sha256");
    expect(script).toContain("RELEASE.2025-09-07T16-13-09Z");
    expect(script).toContain("shasum -a 256 -c");
    expect(script).toContain("DYNAMODB_LOCAL_JAR");
    expect(script).toContain("MINIO_BINARY");
  });
});
