import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { resolve } from "node:path";

// Every HTTP request uses the shipped route handler and its authorization/persistence.
const routes = [
  ["GET", /^\/api\/internal\/job\/([^/]+)$/, () => import("@/app/api/internal/job/[id]/route")],
  ["GET", /^\/api\/internal\/connection\/([^/]+)$/, () => import("@/app/api/internal/connection/[platform]/route")],
  ["GET", /^\/api\/internal\/insights$/, () => import("@/app/api/internal/insights/route")],
  ["GET", /^\/api\/internal\/job\/([^/]+)\/commands$/, () => import("@/app/api/internal/job/[id]/commands/route")],
  ["GET", /^\/api\/internal\/job\/([^/]+)\/receipts$/, () => import("@/app/api/internal/job/[id]/receipts/route")],
  ["GET", /^\/api\/internal\/content-artifacts\/([^/]+)$/, () => import("@/app/api/internal/content-artifacts/[id]/route")],
  ["GET", /^\/api\/internal\/artifacts\/([^/]+)$/, () => import("@/app/api/internal/artifacts/[id]/route")],
  ["POST", /^\/api\/internal\/artifacts$/, () => import("@/app/api/internal/artifacts/route")],
  ["POST", /^\/api\/internal\/content-artifacts\/claim$/, () => import("@/app/api/internal/content-artifacts/claim/route")],
  ["POST", /^\/api\/internal\/content-artifacts$/, () => import("@/app/api/internal/content-artifacts/route")],
  ["POST", /^\/api\/internal\/strategy-context$/, () => import("@/app/api/internal/strategy-context/route")],
  ["POST", /^\/api\/internal\/strategy$/, () => import("@/app/api/internal/strategy/route")],
  ["POST", /^\/api\/internal\/event-inbox\/claim$/, () => import("@/app/api/internal/event-inbox/claim/route")],
  ["POST", /^\/api\/internal\/event-inbox\/finalize$/, () => import("@/app/api/internal/event-inbox/finalize/route")],
  ["POST", /^\/api\/internal\/operation\/claim$/, () => import("@/app/api/internal/operation/claim/route")],
  ["POST", /^\/api\/internal\/stage-execution\/claim$/, () => import("@/app/api/internal/stage-execution/claim/route")],
  ["POST", /^\/api\/internal\/stage-execution\/finalize$/, () => import("@/app/api/internal/stage-execution/finalize/route")],
  ["POST", /^\/api\/internal\/effect-claim$/, () => import("@/app/api/internal/effect-claim/route")],
  ["POST", /^\/api\/internal\/effect-command\/([^/]+)\/dispatch$/, () => import("@/app/api/internal/effect-command/[id]/dispatch/route")],
  ["POST", /^\/api\/internal\/receipt$/, () => import("@/app/api/internal/receipt/route")],
  ["POST", /^\/api\/internal\/verification$/, () => import("@/app/api/internal/verification/route")],
  ["POST", /^\/api\/internal\/engagement$/, () => import("@/app/api/internal/engagement/route")],
  ["POST", /^\/api\/internal\/failure$/, () => import("@/app/api/internal/failure/route")],
  ["POST", /^\/api\/internal\/publish\/([^/]+)\/complete$/, () => import("@/app/api/internal/publish/[id]/complete/route")],
] as const;

export async function campaignWorkerBridge(options: { loseProviderResponse?: boolean } = {}) {
  const requests: Array<{ path: string; status: number; body?: string }> = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url!, "http://127.0.0.1");
      const route = routes.find(([method, pattern]) => method === incoming.method && pattern.test(url.pathname));
      if (!route) throw new Error(`Unexpected worker API: ${incoming.method} ${url.pathname}`);
      const parts: Buffer[] = []; for await (const part of incoming) parts.push(Buffer.from(part));
      const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const request = new Request(url, { method: incoming.method, headers, ...(parts.length ? { body: Buffer.concat(parts) } : {}) });
      const handlers = await route[2]() as Record<string, (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>>;
      const param = route[1].exec(url.pathname)?.[1] ?? "";
      const result = await handlers[incoming.method!](request, { params: Promise.resolve({ id: param, platform: param }) });
      const body = await result.text(); requests.push({ path: url.pathname, status: result.status, ...(result.status >= 400 || url.pathname === "/api/internal/failure" ? { body } : {}) });
      outgoing.writeHead(result.status, Object.fromEntries(result.headers.entries())); outgoing.end(body);
    } catch (error) { requests.push({ path: incoming.url!, status: 500, body: String(error) }); outgoing.writeHead(500); outgoing.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address() as { port: number };
  return {
    requests,
    run: (payload: unknown) => new Promise<{ acknowledged: boolean; result: Record<string, unknown>; providerRoles: string[] }>((done, reject) => {
      const child = execFile(resolve("agent/.venv/bin/python"), ["-m", "tests.campaign_worker_fixture"], { cwd: resolve("agent"), env: { ...process.env, WEB_INTERNAL_URL: `http://127.0.0.1:${address.port}`, MEMORY_BANK_ENABLED: "false", AWS_EC2_METADATA_DISABLED: "true", ...(options.loseProviderResponse ? { HARMONIA_LOCAL_EFFECT_RESPONSE_LOSS: "true" } : {}) }, timeout: 45000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}\n${JSON.stringify(requests.filter(request => request.status >= 400))}`));
        else { try { done(JSON.parse(stdout)); } catch { reject(new Error(`${stdout}\n${stderr}`)); } }
      });
      child.stdin!.end(JSON.stringify(payload));
    }),
    close: () => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())),
  };
}
