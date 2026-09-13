import { createServer } from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertLoopbackTarget, runLocalLoad } from "../scripts/local-load";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("local load harness", () => {
  it("refuses non-loopback targets", () => {
    expect(() => assertLoopbackTarget("https://useharmonia.example/api/health")).toThrow("loopback");
  });

  it("measures bounded concurrent requests against a real local HTTP server", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    }).listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");

    const result = await runLocalLoad({
      target: `http://127.0.0.1:${address.port}/api/health`,
      requests: 40,
      concurrency: 8,
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({ requests: 40, completed: 40, failed: 0, statuses: { "200": 40 } });
    expect(result.p95Ms).toBeGreaterThanOrEqual(0);
  });

  it("runs through the checked-in package command runtime", () => {
    const run = spawnSync(join(process.cwd(), "node_modules/.bin/tsx"), ["scripts/local-load.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        LOAD_TARGET: "http://127.0.0.1:9/api/health",
        LOAD_REQUESTS: "1",
        LOAD_CONCURRENCY: "1",
        LOAD_TIMEOUT_MS: "50",
      },
    });
    expect(run.stderr).not.toContain("Top-level await");
    expect(JSON.parse(run.stdout)).toMatchObject({ requests: 1, completed: 1, failed: 1 });
  });
});
