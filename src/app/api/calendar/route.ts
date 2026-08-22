import { listJobs, listReceipts } from "@/lib/firestore";

export interface CalendarEvent {
  date: string; // YYYY-MM-DD
  kind: "job_created" | "published";
  jobId: string;
  label: string;
}

/** Content calendar feed: job creation dates + real published-post dates. */
export async function GET() {
  const jobs = await listJobs(100);
  const events: CalendarEvent[] = [];

  for (const job of jobs) {
    events.push({
      date: (job.createdAt ?? "").slice(0, 10),
      kind: "job_created",
      jobId: job.id,
      label: job.ingestedTitle ?? job.config.youtubeUrl ?? job.config.brief ?? "content job",
    });
    const receipts = await listReceipts(job.id);
    for (const r of receipts) {
      if (r.outcome === "applied" && r.actionType === "publish_x_post") {
        events.push({
          date: r.performedAt.slice(0, 10),
          kind: "published",
          jobId: job.id,
          label: `Published post (${job.ingestedTitle ?? job.id.slice(0, 8)})`,
        });
      }
    }
  }

  return Response.json({ events: events.filter((e) => e.date && e.date !== "") });
}
