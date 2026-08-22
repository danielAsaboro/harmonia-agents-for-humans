"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/clientApi";
import type { ChatResponse } from "@/app/api/chat/route";
import type { PostDraft } from "@/lib/types";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  data?: ChatResponse;
}

const STAGE_COLORS: Record<string, string> = {
  complete: "border-emerald-400 text-emerald-600 dark:text-emerald-400",
  failed: "border-red-400 text-red-600 dark:text-red-400",
  awaiting_approval: "border-amber-400 text-amber-600 dark:text-amber-400",
};

function JobCardView({ job }: { job: NonNullable<ChatResponse["job"]> }) {
  const color = STAGE_COLORS[job.stage] ?? "border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400";
  return (
    <div className={`rounded-lg border px-3 py-2 text-xs ${color}`}>
      <div className="font-mono">{job.id}</div>
      <div className="mt-0.5 flex items-center gap-2">
        <span className="rounded border px-1.5 py-0.5 font-medium uppercase tracking-wide">{job.stage}</span>
        <span>{job.status}</span>
      </div>
      {job.title && <div className="mt-1 truncate opacity-80">{job.title}</div>}
    </div>
  );
}

export default function ChatDrawer({ onJobCreated }: { onJobCreated?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      text: 'Ask me to run the pipeline. E.g. "create a job from https://youtu.be/..." or "status".',
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, open]);

  async function decide(jobId: string, actionId: string, decision: "approved" | "rejected") {
    await apiFetch(`/api/jobs/${jobId}/actions/${actionId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    setMessages((m) => [
      ...m,
      { role: "assistant", text: `${decision === "approved" ? "Approved" : "Rejected"} action ${actionId} on job ${jobId}.` },
    ]);
  }

  async function send() {
    const message = input.trim();
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
        if (data.intent === "create_job" && data.jobId) onJobCreated?.(data.jobId);
      }
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", text: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Open operator chat"
          className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-zinc-800 text-white shadow-lg hover:bg-zinc-600 dark:bg-zinc-200 dark:text-black"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
        </button>
      )}
      {open && (
        <div className="fixed bottom-5 right-5 z-40 flex h-[480px] w-[360px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-xl border border-zinc-300 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-950">
          <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <span className="text-xs font-semibold uppercase tracking-wide">Operator chat</span>
            <button onClick={() => setOpen(false)} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200" aria-label="Close chat">✕</button>
          </div>
          <div ref={scrollRef} className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 py-2">
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "self-end" : "self-start"}>
                <div className={`max-w-[280px] whitespace-pre-wrap rounded-lg px-3 py-1.5 text-xs leading-5 ${
                  m.role === "user"
                    ? "bg-zinc-800 text-white dark:bg-zinc-200 dark:text-black"
                    : "bg-zinc-100 text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
                }`}>
                  {m.text}
                </div>
                {m.data && (
                  <div className="mt-1 flex max-w-[280px] flex-col gap-1">
                    {m.data.job && <JobCardView job={m.data.job} />}
                    {m.data.jobs?.map((j) => <JobCardView key={j.id} job={j} />)}
                    {m.data.drafts?.map((d: PostDraft) => (
                      <div key={d.id} className="rounded-lg border border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
                        <div className="mb-1 font-medium uppercase tracking-wide text-zinc-400">{d.platform}{d.valid ? "" : " · invalid"}</div>
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
            {busy && <div className="self-start text-xs text-zinc-400">thinking…</div>}
          </div>
          <div className="flex gap-1.5 border-t border-zinc-200 p-2 dark:border-zinc-800">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void send()}
              placeholder="e.g. status of job abc123"
              className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
            />
            <button
              onClick={() => void send()}
              disabled={busy}
              className="shrink-0 rounded-md bg-zinc-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-600 disabled:opacity-50 dark:bg-zinc-200 dark:text-black"
            >
              Send
            </button>
          </div>
        </div>
      )}
    </>
  );
}
