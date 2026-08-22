import { listEvents, listJobs, listReceipts } from "@/lib/firestore";
import { STAGES } from "@/lib/types";

export interface StageDwell {
  stage: string;
  avgSec: number;
  samples: number;
}

export interface MetricsResponse {
  totals: {
    jobs: number;
    running: number;
    waiting_for_approval: number;
    complete: number;
    failed: number;
  };
  stages: Array<{ stage: string; count: number }>;
  receipts: { applied: number; already_applied: number; failed: number; rejected: number };
  stageDwell: StageDwell[];
  recentEvents: Array<{ at: string | null; jobId: string; stage: string; message: string; actor: string }>;
}

const DWELL_SAMPLE_JOBS = 15;
const RECENT_EVENTS_LIMIT = 40;

function diffSeconds(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.max(0, Math.round((to - from) / 1000));
}

export async function GET() {
  const jobs = await listJobs(100);

  const totals = {
    jobs: jobs.length,
    running: jobs.filter((j) => j.status === "running").length,
    waiting_for_approval: jobs.filter((j) => j.stage === "awaiting_approval").length,
    complete: jobs.filter((j) => j.status === "complete").length,
    failed: jobs.filter((j) => j.status === "failed").length,
  };

  const stages = STAGES.map((stage) => ({
    stage,
    count: jobs.filter((j) => j.stage === stage).length,
  })).filter((s) => s.count > 0);

  const sample = jobs.slice(0, DWELL_SAMPLE_JOBS);
  const [dwellLists, receiptLists, eventLists] = await Promise.all([
    Promise.all(sample.map((j) => listEvents(j.id))),
    Promise.all(sample.map((j) => listReceipts(j.id))),
    Promise.all(sample.map((j) => listEvents(j.id))),
  ]);

  const dwellAcc = new Map<string, number[]>();
  for (const events of dwellLists) {
    const ordered = [...events].sort(
      (a, b) => (Date.parse(a.at ?? "0") || 0) - (Date.parse(b.at ?? "0") || 0),
    );
    for (let i = 0; i < ordered.length - 1; i++) {
      const sec = diffSeconds(ordered[i].at ?? "", ordered[i + 1].at ?? "");
      if (sec === null) continue;
      const list = dwellAcc.get(ordered[i].stage) ?? [];
      list.push(sec);
      dwellAcc.set(ordered[i].stage, list);
    }
  }
  const stageDwell: StageDwell[] = [...dwellAcc.entries()]
    .map(([stage, secs]) => ({
      stage,
      avgSec: Math.round(secs.reduce((a, b) => a + b, 0) / secs.length),
      samples: secs.length,
    }))
    .sort((a, b) => b.samples - a.samples);

  const receipts = { applied: 0, already_applied: 0, failed: 0, rejected: 0 };
  for (const rs of receiptLists) {
    for (const r of rs) {
      if (r.outcome in receipts) {
        receipts[r.outcome as keyof typeof receipts] += 1;
      }
    }
  }

  const recentEvents = eventLists
    .flatMap((events, i) => events.map((e) => ({ ...e, jobId: sample[i].id })))
    .sort((a, b) => (Date.parse(b.at ?? "0") || 0) - (Date.parse(a.at ?? "0") || 0))
    .slice(0, RECENT_EVENTS_LIMIT)
    .map((e) => ({ at: e.at, jobId: e.jobId, stage: e.stage, message: e.message, actor: e.actor }));

  return Response.json({ totals, stages, receipts, stageDwell, recentEvents } satisfies MetricsResponse);
}
