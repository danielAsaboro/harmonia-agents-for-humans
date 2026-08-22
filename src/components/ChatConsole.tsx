"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/clientApi";
import { SendIcon } from "@/components/icons";
import JobDetail from "@/components/JobDetail";
import type { TimelineEvent } from "@/components/Timeline";
import type { ChatResponse } from "@/app/api/chat/route";
import type { JobFull, PostDraft, Receipt } from "@/components/jobTypes";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  data?: ChatResponse;
}

interface JobDetailBundle {
  job: JobFull;
  events: TimelineEvent[];
  receipts: Receipt[];
}

const SUGGESTIONS = [
  "Create posts announcing our Series A raise",
  "Turn https://www.youtube.com/watch?v=… into a thread",
  "What's the status of my latest job?",
];

const STAGE_COLORS: Record<string, string> = {
  complete: "border-emerald-400 text-emerald-600 dark:text-emerald-400",
  failed: "border-red-400 text-red-600 dark:text-red-400",
  awaiting_approval: "border-amber-400 text-amber-600 dark:text-amber-400",
};

function JobCardView({
  job,
  onOpen,
}: {
  job: NonNullable<ChatResponse["job"]>;
  onOpen?: (id: string) => void;
}) {
  const color =
    STAGE_COLORS[job.stage] ?? "border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400";
  return (
    <button
      onClick={() => onOpen?.(job.id)}
      className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900 ${color}`}
    >
      <div className="font-mono">{job.id}</div>
      <div className="mt-0.5 flex items-center gap-2">
        <span className="rounded border px-1.5 py-0.5 font-medium uppercase tracking-wide">{job.stage}</span>
        <span>{job.status}</span>
      </div>
      {job.title && <div className="mt-1 truncate opacity-80">{job.title}</div>}
    </button>
  );
}

export default function ChatConsole() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      text:
        "I'm your Harmonia operator agent. Give me a topic and I'll ideate and draft posts; give me a YouTube URL and I'll cut clips and drafts from it. Everything stops at your approval before publishing.",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<JobDetailBundle | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const openJob = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/jobs/${id}`, { cache: "no-store" });
      if (!res.ok) return;
      setDetail(await res.json());
    } catch {
      /* transient */
    }
  }, []);

  async function decide(jobId: string, actionId: string, decision: "approved" | "rejected") {
    await apiFetch(`/api/jobs/${jobId}/actions/${actionId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    setMessages((m) => [
      ...m,
      {
        role: "assistant",
        text: `${decision === "approved" ? "Approved" : "Rejected"} action ${actionId} on job ${jobId}.`,
      },
    ]);
    void openJob(jobId);
  }

  async function send(messageText?: string) {
    const message = (messageText ?? input).trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", text: message }]);
    try {
      const res = await apiFetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, surface: "dashboard" }),
      });
      const data = (await res.json().catch(() => null)) as (ChatResponse & { error?: string }) | null;
      if (!res.ok || !data) {
        setMessages((m) => [...m, { role: "assistant", text: data?.error ?? `chat failed (${res.status})` }]);
      } else {
        setMessages((m) => [...m, { role: "assistant", text: data.reply, data }]);
        if (data.jobId) void openJob(data.jobId);
      }
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", text: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen">
      <section className="flex min-w-0 flex-1 flex-col border-r border-zinc-200 dark:border-zinc-800">
        <header className="flex items-center justify-between border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <div>
            <h1 className="text-sm font-semibold tracking-tight">Console</h1>
            <p className="text-[11px] text-zinc-400">One surface for jobs, drafts, approvals — the agent routes it.</p>
          </div>
        </header>

        <div ref={scrollRef} className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 sm:px-6">
          <div className="mx-auto w-full max-w-2xl flex flex-col gap-3">
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "self-end" : "self-start"}>
                <div
                  className={`max-w-xl whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-6 ${
                    m.role === "user"
                      ? "bg-zinc-900 text-white dark:bg-white dark:text-black"
                      : "bg-zinc-100 text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
                  }`}
                >
                  {m.text}
                </div>
                {m.data && (
                  <div className="mt-2 flex max-w-xl flex-col gap-1.5">
                    {m.data.job && <JobCardView job={m.data.job} onOpen={openJob} />}
                    {m.data.jobs?.map((j) => <JobCardView key={j.id} job={j} onOpen={openJob} />)}
                    {m.data.drafts?.map((d: PostDraft) => (
                      <div key={d.id} className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs leading-5 dark:border-zinc-800 dark:bg-zinc-950">
                        <div className="mb-1 font-medium uppercase tracking-wide text-zinc-400">
                          {d.platform}{d.valid ? "" : " · invalid"}
                        </div>
                        {d.text}
                      </div>
                    ))}
                    {m.data.pendingActions && m.data.job && m.data.pendingActions.map((a) => (
                      <div key={a.id} className="flex items-center gap-2 rounded-lg border border-amber-300 px-3 py-2 text-xs dark:border-amber-700">
                        <span className="min-w-0 flex-1 truncate" title={a.title}>{a.title}</span>
                        <button onClick={() => decide(m.data!.job!.id, a.id, "approved")} className="rounded bg-emerald-600 px-2 py-0.5 font-medium text-white hover:bg-emerald-500">Approve</button>
                        <button onClick={() => decide(m.data!.job!.id, a.id, "rejected")} className="rounded bg-zinc-300 px-2 py-0.5 font-medium text-black hover:bg-zinc-400 dark:bg-zinc-700 dark:text-white">Reject</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {busy && <div className="self-start text-xs text-zinc-400">working…</div>}
          </div>
        </div>

        <footer className="border-t border-zinc-200 px-4 py-3 sm:px-6 dark:border-zinc-800">
          <div className="mx-auto w-full max-w-2xl">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => void send(s)}
                  disabled={busy}
                  className="rounded-full border border-zinc-200 px-3 py-1 text-[11px] text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-700 disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-400"
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void send()}
                placeholder="Describe a topic, paste a YouTube URL, ask for status…"
                className="w-full rounded-full border border-zinc-300 bg-white px-4 py-2.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
              />
              <button
                onClick={() => void send()}
                disabled={busy || !input.trim()}
                aria-label="Send"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-black"
              >
                <SendIcon />
              </button>
            </div>
          </div>
        </footer>
      </section>

      {detail && (
        <aside className="hidden w-[420px] shrink-0 overflow-y-auto p-4 lg:block xl:w-[520px]">
          <JobDetail
            job={detail.job}
            events={detail.events}
            receipts={detail.receipts}
            assets={detail.job.assets ?? []}
            onDecide={(actionId, decision) =>
              decide(detail.job.id, actionId, decision)
            }
            onRetry={async () => {
              await apiFetch(`/api/jobs/${detail.job.id}/retry`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({}),
              });
              void openJob(detail.job.id);
            }}
          />
        </aside>
      )}
    </div>
  );
}
