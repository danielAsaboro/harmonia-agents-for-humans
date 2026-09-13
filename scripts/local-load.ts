import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface LocalLoadOptions {
  readonly concurrency: number;
  readonly requests: number;
  readonly target: string;
  readonly timeoutMs: number;
}

export interface LocalLoadResult {
  readonly completed: number;
  readonly concurrency: number;
  readonly durationMs: number;
  readonly failed: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly requests: number;
  readonly requestsPerSecond: number;
  readonly statuses: Record<string, number>;
  readonly target: string;
  readonly timeoutMs: number;
}

export function assertLoopbackTarget(value: string): URL {
  const target = new URL(value);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(target.hostname)) {
    throw new Error("local load target must use a loopback hostname");
  }
  if (!new Set(["http:", "https:"]).has(target.protocol)) throw new Error("local load target must use HTTP");
  return target;
}

function requiredPositiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

export async function runLocalLoad(options: LocalLoadOptions): Promise<LocalLoadResult> {
  const target = assertLoopbackTarget(options.target).toString();
  const requests = requiredPositiveInteger(options.requests, "requests", 100_000);
  const concurrency = requiredPositiveInteger(options.concurrency, "concurrency", 500);
  const timeoutMs = requiredPositiveInteger(options.timeoutMs, "timeoutMs", 60_000);
  const timings: number[] = [];
  const statuses: Record<string, number> = {};
  let cursor = 0;
  let failed = 0;
  const suiteStarted = performance.now();

  const worker = async () => {
    while (true) {
      const requestIndex = cursor;
      cursor += 1;
      if (requestIndex >= requests) return;
      const started = performance.now();
      try {
        const response = await fetch(target, {
          headers: { accept: "application/json", "user-agent": "harmonia-local-load/1" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        await response.arrayBuffer();
        const key = String(response.status);
        statuses[key] = (statuses[key] ?? 0) + 1;
        if (!response.ok) failed += 1;
      } catch {
        statuses.transport_error = (statuses.transport_error ?? 0) + 1;
        failed += 1;
      } finally {
        timings.push(performance.now() - started);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, worker));
  const durationMs = performance.now() - suiteStarted;
  timings.sort((a, b) => a - b);
  const round = (value: number) => Number(value.toFixed(3));
  return {
    completed: timings.length,
    concurrency,
    durationMs: round(durationMs),
    failed,
    meanMs: round(timings.reduce((sum, value) => sum + value, 0) / timings.length),
    p50Ms: round(percentile(timings, 0.5)),
    p95Ms: round(percentile(timings, 0.95)),
    p99Ms: round(percentile(timings, 0.99)),
    requests,
    requestsPerSecond: round((requests * 1_000) / durationMs),
    statuses,
    target,
    timeoutMs,
  };
}

async function main(): Promise<void> {
  const result = await runLocalLoad({
    target: process.env.LOAD_TARGET ?? "http://127.0.0.1:3000/api/health",
    requests: Number(process.env.LOAD_REQUESTS ?? "1000"),
    concurrency: Number(process.env.LOAD_CONCURRENCY ?? "25"),
    timeoutMs: Number(process.env.LOAD_TIMEOUT_MS ?? "2000"),
  });
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (process.env.LOAD_OUTPUT) {
    const outputPath = resolve(process.env.LOAD_OUTPUT);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, output, { encoding: "utf8", mode: 0o600 });
  }
  process.stdout.write(output);
  const maxErrorRate = Number(process.env.LOAD_MAX_ERROR_RATE ?? "0");
  const maxP95Ms = Number(process.env.LOAD_MAX_P95_MS ?? "500");
  if (result.failed / result.requests > maxErrorRate || result.p95Ms > maxP95Ms) process.exitCode = 1;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
