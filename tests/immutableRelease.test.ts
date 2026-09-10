import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("immutable release inputs", () => {
  const web = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  const agent = readFileSync(new URL("../agent/Dockerfile", import.meta.url), "utf8");
  const deploy = readFileSync(new URL("../infra/deploy.sh", import.meta.url), "utf8");

  it("pins both runtime base images by sha256 digest", () => {
    expect(web).toMatch(/^FROM node:[^\s]+@sha256:[a-f0-9]{64}/m);
    expect(agent).toMatch(/^FROM python:[^\s]+@sha256:[a-f0-9]{64}/m);
  });

  it("runs the web build and runtime on the Node version used in the production image", () => {
    expect(web.match(/^FROM node:([^\s@]+)/gm)).toEqual([
      "FROM node:22-bookworm-slim",
      "FROM node:22-bookworm-slim",
      "FROM node:22-bookworm-slim",
    ]);
  });

  it("requires a pinned cognition image and content-addresses worker build assets", () => {
    const stack=readFileSync(new URL("../infra/aws/stack.ts", import.meta.url), "utf8");
    expect(stack).toContain("AgentCoreImageUri");
    expect(stack).toContain("sha256 digest");
    expect(stack).toContain("ContainerImage.fromAsset");
    expect(deploy).toContain("cdk deploy");
  });
});
