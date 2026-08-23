import { listEventLog, type EventLogEntry } from "@/lib/firestore";
import { tenantHandler } from "@/lib/auth";

/**
 * Searchable, filterable log stream.
 * Query params: q (text), stage (repeatable), actor, jobId, since, until, limit.
 */
async function get(req: Request) {
  const params = new URL(req.url).searchParams;
  const q = (params.get("q") ?? "").trim().toLowerCase();
  const stages = params.getAll("stage").filter(Boolean);
  const actor = params.get("actor") ?? "";
  const jobId = params.get("jobId") ?? "";
  const since = params.get("since");
  const until = params.get("until");
  const limit = Math.min(Math.max(Number(params.get("limit") ?? "100"), 1), 300);

  let entries: EventLogEntry[] = await listEventLog(500);

  if (q) entries = entries.filter((e) => e.message.toLowerCase().includes(q) || e.jobId.toLowerCase().includes(q));
  if (stages.length) entries = entries.filter((e) => stages.includes(e.stage));
  if (actor) entries = entries.filter((e) => e.actor === actor);
  if (jobId) entries = entries.filter((e) => e.jobId === jobId);
  if (since) entries = entries.filter((e) => e.at && Date.parse(e.at) >= Date.parse(since));
  if (until) entries = entries.filter((e) => e.at && Date.parse(e.at) <= Date.parse(until));

  const total = entries.length;
  return Response.json({ events: entries.slice(0, limit), total });
}

export const GET = tenantHandler(get);
