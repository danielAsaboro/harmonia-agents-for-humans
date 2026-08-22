"use client";

import { useEffect, useMemo, useState } from "react";
import type { ContentItem } from "@/lib/types";
import { PlatformIcon } from "@/components/socialIcons";

interface ConnectionInfo {
  id: string;
  status: string;
  handle?: string;
}

interface JobBundle {
  job: { id: string; ingestedTitle?: string; moments?: Array<{ id: string; title: string }> };
  assets?: Array<{ actionId: string; mime: string }>;
  receipts?: Array<{ actionId: string; outcome: string }>;
  engagement?: Array<{ postId: string; likes: number; reposts: number; url?: string }>;
}

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400",
  scheduled: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-400",
  awaiting_final_review: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
  publishing: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
  published: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
  failed: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
  cancelled: "bg-zinc-100 text-zinc-400 dark:bg-zinc-900 dark:text-zinc-500",
};

function toLocalInput(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ItemDrawer({
  item,
  onClose,
  onSaved,
  onOpenInChat,
}: {
  item: ContentItem;
  onClose: () => void;
  onSaved: () => void;
  onOpenInChat: (item: ContentItem) => void;
}) {
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [jobData, setJobData] = useState<JobBundle | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState(item.text);
  const [scheduleValue, setScheduleValue] = useState(toLocalInput(item.scheduledFor));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setDraftText(item.text);
      setScheduleValue(toLocalInput(item.scheduledFor));
      setError(null);
    }, 0);
    return () => clearTimeout(t);
  }, [item.id, item.text, item.scheduledFor]);

  useEffect(() => {
    fetch("/api/settings/connections", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setConnections(d.connections ?? []))
      .catch(() => {});
  }, [item.id]);

  useEffect(() => {
    let alive = true;
    fetch(`/api/jobs/${item.jobId}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("not found"))))
      .then((d) => {
        if (alive) setJobData(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [item.jobId]);

  const immutable = ["published", "publishing"].includes(item.status);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/content-items`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-operator-token": localStorage.getItem("harmonia-operator-token") ?? "",
        },
        body: JSON.stringify({ id: item.id, ...body }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const channelRows = useMemo(
    () =>
      item.platforms.map((p) => ({
        platform: p,
        conn: connections.find((c) => c.id === p),
      })),
    [item.platforms, connections],
  );

  const publishedEngagement = jobData?.engagement;

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col overflow-y-auto border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_STYLE[item.status] ?? ""}`}>
            {item.status.replace(/_/g, " ")}
          </span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            item.publishMode === "auto" ? "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-400" : "border border-zinc-300 text-zinc-500 dark:border-zinc-700"
          }`}>
            {item.publishMode === "auto" ? "auto-publish" : "human review"}
          </span>
        </div>
        <button onClick={onClose} aria-label="Close" className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">✕</button>
      </header>

      <div className="flex flex-1 flex-col gap-5 p-4">
        {/* Media attached to this post */}
        {item.assetActionIds && item.assetActionIds.length > 0 && (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">Attached media</h3>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {item.assetActionIds.map((actionId) => {
                const asset = jobData?.assets?.find((a) => a.actionId === actionId);
                if (asset?.mime.startsWith("video/")) {
                  return (
                    <video
                      key={actionId}
                      src={`/api/jobs/${item.jobId}/assets/${actionId}`}
                      controls
                      className="h-40 rounded-lg border border-zinc-200 dark:border-zinc-800"
                    />
                  );
                }
                return (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={actionId}
                    src={`/api/jobs/${item.jobId}/assets/${actionId}`}
                    alt="attached media"
                    className="h-40 rounded-lg border border-zinc-200 object-cover dark:border-zinc-800"
                  />
                );
              })}
            </div>
          </section>
        )}

        {/* Post content */}
        <section>
          <div className="mb-1.5 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Post</h3>
            {!immutable && !editing && (
              <button onClick={() => setEditing(true)} className="text-xs text-blue-600 underline dark:text-blue-400">Edit</button>
            )}
          </div>
          {editing ? (
            <>
              <textarea
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                rows={4}
                className="w-full rounded-lg border border-zinc-300 bg-white p-3 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
              />
              <div className="mt-2 flex items-center gap-2">
                <span className={`text-[11px] ${draftText.length > 280 ? "text-red-500" : "text-zinc-400"}`}>{draftText.length}/280</span>
                <button
                  onClick={async () => {
                    await patch({ text: draftText });
                    setEditing(false);
                  }}
                  disabled={busy}
                  className="ml-auto rounded-full bg-zinc-900 px-4 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black"
                >
                  Save
                </button>
                <button
                  onClick={() => {
                    setDraftText(item.text);
                    setEditing(false);
                  }}
                  className="text-xs text-zinc-500 underline"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="whitespace-pre-wrap rounded-lg border border-zinc-200 bg-white p-3 text-sm leading-6 dark:border-zinc-800 dark:bg-zinc-950">
                {item.text}
              </p>
              {(item.revisions?.length ?? 0) > 0 && (
                <p className="mt-1 text-[11px] text-zinc-400">{item.revisions!.length} earlier revision(s) kept in audit trail.</p>
              )}
            </>
          )}
        </section>

        {/* Channels */}
        <section>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">Channels</h3>
          <ul className="flex flex-col gap-1.5">
            {channelRows.map(({ platform, conn }) => (
              <li key={platform} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
                <PlatformIcon id={platform} />
                <span className="font-medium capitalize">{platform}</span>
                {conn?.status === "connected" ? (
                  <span className="text-[11px] text-emerald-600 dark:text-emerald-400">
                    connected{conn.handle ? ` · ${conn.handle}` : ""}
                  </span>
                ) : (
                  <span className="text-[11px] text-amber-600 dark:text-amber-400">not connected — publishing will fail until set up</span>
                )}
              </li>
            ))}
          </ul>
        </section>

        {/* Scheduling */}
        {!immutable && item.status !== "cancelled" && (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">Schedule</h3>
            <div className="flex items-center gap-2">
              <input
                type="datetime-local"
                value={scheduleValue}
                onChange={(e) => setScheduleValue(e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
              />
              <select
                value={item.publishMode}
                onChange={(e) => patch({ publishMode: e.target.value })}
                disabled={busy}
                className="shrink-0 rounded-lg border border-zinc-300 bg-white px-2 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-950"
                title="Auto publishes when due; approval pauses for your review"
              >
                <option value="approval">review first</option>
                <option value="auto">auto-publish</option>
              </select>
            </div>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => patch({ scheduledFor: new Date(scheduleValue).toISOString() })}
                disabled={busy || !scheduleValue}
                className="rounded-full bg-sky-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
              >
                {item.scheduledFor ? "Reschedule" : "Schedule"}
              </button>
              <button
                onClick={() => patch({ scheduledFor: new Date().toISOString() })}
                disabled={busy}
                title="Due immediately — auto mode publishes within a minute; review mode asks you first"
                className="rounded-full border border-zinc-300 px-4 py-1.5 text-xs font-medium hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                Publish now
              </button>
              {item.status !== "draft" && (
                <button
                  onClick={() => patch({ status: "cancelled" })}
                  disabled={busy}
                  className="ml-auto rounded-full border border-red-300 px-4 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-red-900 dark:hover:bg-red-950"
                >
                  Cancel post
                </button>
              )}
            </div>
          </section>
        )}

        {/* Final review */}
        {item.status === "awaiting_final_review" && (
          <section className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/50">
            <h3 className="text-xs font-semibold text-amber-800 dark:text-amber-300">Final review needed</h3>
            <p className="mt-1 text-xs leading-5 text-amber-700 dark:text-amber-400">
              This post is due and waits for your decision.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={async () => {
                  await fetch(`/api/content-items/${item.id}/approve`, {
                    method: "POST",
                    headers: { "content-type": "application/json", "x-operator-token": localStorage.getItem("harmonia-operator-token") ?? "" },
                    body: JSON.stringify({ decision: "approved" }),
                  });
                  onSaved();
                }}
                className="rounded-full bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
              >
                Approve &amp; publish
              </button>
              <button
                onClick={async () => {
                  await fetch(`/api/content-items/${item.id}/approve`, {
                    method: "POST",
                    headers: { "content-type": "application/json", "x-operator-token": localStorage.getItem("harmonia-operator-token") ?? "" },
                    body: JSON.stringify({ decision: "rejected" }),
                  });
                  onSaved();
                }}
                className="rounded-full border border-zinc-300 px-4 py-1.5 text-xs font-medium dark:border-zinc-700"
              >
                Reject
              </button>
            </div>
          </section>
        )}

        {/* Provenance + outcome */}
        <section>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">Provenance &amp; outcome</h3>
          <dl className="space-y-1 text-xs">
            <div className="flex gap-2"><dt className="w-20 shrink-0 text-zinc-400">Job</dt><dd className="truncate font-mono">{item.jobId}</dd></div>
            {jobData?.job?.ingestedTitle && (
              <div className="flex gap-2"><dt className="w-20 shrink-0 text-zinc-400">Source</dt><dd className="truncate">{jobData.job.ingestedTitle}</dd></div>
            )}
            {item.publishedUrl && (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-zinc-400">Live post</dt>
                <dd><a href={item.publishedUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline dark:text-blue-400">open ↗</a></dd>
              </div>
            )}
            {publishedEngagement && publishedEngagement.length > 0 && (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-zinc-400">Reactions</dt>
                <dd>{publishedEngagement.map((e) => `${e.likes} likes · ${e.reposts} reposts`).join("; ")}</dd>
              </div>
            )}
            {item.failureReason && (
              <div className="flex gap-2"><dt className="w-20 shrink-0 text-zinc-400">Failure</dt><dd className="text-red-600 dark:text-red-400">{item.failureReason}</dd></div>
            )}
          </dl>

          {jobData?.assets && jobData.assets.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-[11px] uppercase tracking-wide text-zinc-400">Assets from this job</p>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {jobData.assets.map((a) => (
                  a.mime.startsWith("video/") ? (
                    <video key={a.actionId} src={`/api/jobs/${item.jobId}/assets/${a.actionId}`} controls className="h-24 rounded-lg" />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={a.actionId} src={`/api/jobs/${item.jobId}/assets/${a.actionId}`} alt="" className="h-24 rounded-lg object-cover" />
                  )
                ))}
              </div>
            </div>
          )}
        </section>

        {error && (
          <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}
      </div>

      <footer className="sticky bottom-0 border-t border-zinc-200 bg-white/95 p-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
        <button
          onClick={() => onOpenInChat(item)}
          className="w-full rounded-full bg-zinc-900 px-4 py-2 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-black dark:hover:bg-zinc-300"
        >
          Open in chat for further processing →
        </button>
      </footer>
    </aside>
  );
}
