"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/clientApi";
import { SendIcon } from "@/components/icons";
import JobDetail from "@/components/JobDetail";
import type { TimelineEvent } from "@/components/Timeline";
import type { ChatResponse } from "@/app/api/chat/route";
import { groupSessions, sessionPreview, dayLabel } from "@/lib/chatSessions";
import type { ChatSession } from "@/lib/chatSessions";
import type { JobFull, PostDraft, Receipt } from "@/components/jobTypes";
import { useHarmoniaChat } from "@/hooks/useHarmoniaChat";
import type { ChatRunState } from "@/lib/a2ui/chatReducer";
import { historyRunState } from "@/lib/a2ui/historyReplay";
import { HarmoniaA2uiHost } from "@/components/a2ui/HarmoniaCatalog";
import { AttachmentComposer, type ComposerAttachment } from "@/components/a2ui/AttachmentComposer";
import {
  ActivityTrace,
  AttachmentCard,
  ConfirmationCard,
  MessageContent,
  ToolActivity,
} from "@/components/a2ui/HarmoniaElements";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  data?: ChatResponse;
  surface?: string;
  at?: string | null;
  attachments?: ComposerAttachment[];
  run?: ChatRunState;
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

function SurfaceBadge({ surface }: { surface?: string }) {
  if (surface !== "telegram") return null;
  return (
    <span className="rounded bg-sky-100 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-sky-700 dark:bg-sky-950 dark:text-sky-400">
      TG
    </span>
  );
}

function Bubble({
  m,
  onOpenJob,
  onDecide,
  onOperationDecision,
}: {
  m: ChatMessage;
  onOpenJob: (id: string) => void;
  onDecide: (jobId: string, actionId: string, decision: "approved" | "rejected") => void;
  onOperationDecision: (operationId: string, decision: "approved" | "rejected") => void;
}) {
  return (
    <div className={m.role === "user" ? "self-end" : "self-start"}>
      <div className={`mb-0.5 flex items-center gap-1.5 ${m.role === "user" ? "justify-end" : ""}`}>
        <SurfaceBadge surface={m.surface} />
        {m.at && (
          <span className="text-[9px] text-zinc-400">
            {new Date(m.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>
      <div
        className={`max-w-xl whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-6 ${
          m.role === "user"
            ? "bg-zinc-900 text-white dark:bg-white dark:text-black"
            : "bg-zinc-100 text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
        }`}
      >
        <MessageContent text={m.text} />
      </div>
      {m.attachments && m.attachments.length > 0 && (
        <div className="mt-2 grid max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
          {m.attachments.map((attachment) => <AttachmentCard key={attachment.attachmentId} attachment={attachment} />)}
        </div>
      )}
      {m.run && (
        <div className="mt-2 flex max-w-xl flex-col gap-2">
          {m.run.activities.length > 0 && <ActivityTrace title="Agent activity" steps={m.run.activities} />}
          {m.run.tools.map((tool, index) => <ToolActivity key={`${tool.traceId ?? tool.name}-${index}`} {...tool} />)}
          {m.run.confirmations.map((confirmation) => (
            <ConfirmationCard
              key={confirmation.id}
              title={confirmation.title}
              description={confirmation.description}
              risk={confirmation.risk}
              state={confirmation.state}
              onDecision={(decision) => {
                if (confirmation.operationId) onOperationDecision(confirmation.operationId, decision);
                else if (confirmation.jobId && confirmation.actionId) onDecide(confirmation.jobId, confirmation.actionId, decision);
              }}
            />
          ))}
          {m.run.operations.length > 0 && (
            <HarmoniaA2uiHost
              operations={m.run.operations}
              onAction={(action) => {
                if (action.name === "decide_job_action") {
                  const jobId = String(action.context.jobId ?? "");
                  const actionId = String(action.context.actionId ?? "");
                  const decision = action.context.decision;
                  if (jobId && actionId && (decision === "approved" || decision === "rejected")) {
                    onDecide(jobId, actionId, decision);
                  }
                  return;
                }
                if (action.name !== "decide_operation") return;
                const operationId = String(action.context.operationId ?? "");
                const decision = action.context.decision;
                if (operationId && (decision === "approved" || decision === "rejected")) {
                  onOperationDecision(operationId, decision);
                }
              }}
            />
          )}
          {m.run.error && <p className="rounded-xl border border-red-300 bg-red-50 p-3 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">{m.run.error}</p>}
        </div>
      )}
      {(m.data?.job || m.data?.jobs || m.data?.drafts || m.data?.pendingActions || m.data?.assets) && (
        <div className="mt-2 flex max-w-xl flex-col gap-1.5">
          {m.data?.assets && m.data.assets.length > 0 && (
            <div className="flex gap-2 overflow-x-auto rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-950">
              {m.data.assets.map((a) =>
                a.mime.startsWith("video/") ? (
                  <video
                    key={a.actionId}
                    src={`/api/jobs/${m.data!.jobId ?? m.data!.job?.id}/assets/${a.actionId}`}
                    controls
                    className="h-28 rounded-lg"
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={a.actionId}
                    src={`/api/jobs/${m.data!.jobId ?? m.data!.job?.id}/assets/${a.actionId}`}
                    alt={`generated asset ${a.actionId}`}
                    className="h-28 rounded-lg object-cover"
                  />
                ),
              )}
            </div>
          )}
          {m.data?.job && <JobCardView job={m.data.job} onOpen={onOpenJob} />}
          {m.data?.jobs?.map((j) => <JobCardView key={j.id} job={j} onOpen={onOpenJob} />)}
          {m.data?.drafts?.map((d: PostDraft) => (
            <div key={d.id} className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs leading-5 dark:border-zinc-800 dark:bg-zinc-950">
              <div className="mb-1 font-medium uppercase tracking-wide text-zinc-400">
                {d.platform}{d.valid ? "" : " · invalid"}
              </div>
              {d.text}
            </div>
          ))}
          {m.data?.pendingActions && m.data.job && m.data.pendingActions.map((a) => (
            <ConfirmationCard
              key={a.id}
              title={a.title}
              description={`${a.type} · action ${a.id}`}
              risk={a.risk === "high" ? "high" : a.risk === "low" ? "low" : "material"}
              state="pending"
              onDecision={(decision) => onDecide(m.data!.job!.id, a.id, decision)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

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
      className={`w-full rounded-lg border px-3 py-2 text-left text-xs transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900 ${color}`}
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

const STAGE_COLORS: Record<string, string> = {
  complete: "border-emerald-400 text-emerald-600 dark:text-emerald-400",
  failed: "border-red-400 text-red-600 dark:text-red-400",
  awaiting_approval: "border-amber-400 text-amber-600 dark:text-amber-400",
};

export default function ChatConsole() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [detail, setDetail] = useState<JobDetailBundle | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const completedRuns = useRef(new Set<string>());
  const chat = useHarmoniaChat();

  useEffect(() => {
    const t = setTimeout(() => {
      fetch("/api/chat/history?limit=120", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(async (d: { messages: Array<{ role: string; text: string; data?: ChatResponse; surface?: string; at?: string }> }) => {
          const hydrated = await Promise.all(d.messages.map(async (m): Promise<ChatMessage> => {
            let run: ChatRunState | undefined;
            if (m.role === "assistant" && m.data?.chatRunId) {
              try {
                const response = await fetch(`/api/chat/runs/${m.data.chatRunId}/events?after=-1`, { cache: "no-store" });
                const body = await response.json().catch(() => null) as { events?: unknown[]; error?: string } | null;
                if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
                run = historyRunState(m.data.chatRunId, Array.isArray(body?.events) ? body.events : [body]);
              } catch (error) {
                run = historyRunState(m.data.chatRunId, [{
                  type: "run_failed",
                  runId: m.data.chatRunId,
                  sequence: 0,
                  failedAt: new Date().toISOString(),
                  error: `Chat history replay unavailable: ${error instanceof Error ? error.message : String(error)}`,
                  permanent: false,
                }]);
              }
            }
            return {
              role: m.role === "user" ? "user" : "assistant",
              text: m.text,
              data: m.data,
              surface: m.surface,
              at: m.at,
              attachments: m.data?.attachments?.map((attachment) => ({ ...attachment, progress: 100 })),
              run,
            };
          }));
          setMessages(hydrated);
        })
        .catch(() => {
          setMessages([
            {
              role: "assistant",
              text:
                "I'm your Harmonia operator agent. Give me a topic and I'll ideate and draft posts; give me a YouTube URL and I'll cut clips and drafts from it. Everything stops at your approval before publishing.",
            },
          ]);
        })
        .finally(() => setLoaded(true));
    }, 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, activeSessionId, chat.run]);

  useEffect(() => {
    const run = chat.run;
    if (!run || run.status === "running" || completedRuns.current.has(run.runId)) return;
    completedRuns.current.add(run.runId);
    setMessages((current) => [...current, {
      role: "assistant",
      text: run.status === "complete" ? run.text : run.error ?? "Chat run failed",
      run,
      surface: "dashboard",
      at: new Date().toISOString(),
    }]);
  }, [chat.run]);

  const sessions = useMemo(() => groupSessions(messages), [messages]);
  const visible = useMemo(() => {
    if (!activeSessionId) return sessions;
    const s = sessions.find((x) => x.id === activeSessionId);
    return s ? [s] : sessions;
  }, [sessions, activeSessionId]);

  const openJob = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/jobs/${id}`, { cache: "no-store" });
      if (!res.ok) return;
      setDetail(await res.json());
    } catch {
      /* transient */
    }
  }, []);

  // Deep-link handoff from calendar item drawer ("Open in chat").
  useEffect(() => {
    const t = setTimeout(() => {
      const q = new URLSearchParams(window.location.search);
      const jobParam = q.get("job");
      if (jobParam) {
        void openJob(jobParam);
        window.history.replaceState({}, "", window.location.pathname);
        if (q.get("item")) {
          setInput("Refine the post from this job — make it punchier and suggest a better posting time.");
        }
      }
    }, 0);
    return () => clearTimeout(t);
  }, [openJob]);


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
        surface: "dashboard",
        at: new Date().toISOString(),
      },
    ]);
    void openJob(jobId);
  }

  async function decideOperation(operationId: string, decision: "approved" | "rejected") {
    const response = await apiFetch(`/api/chat/operations/${operationId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    const body = await response.json().catch(() => null) as { error?: string } | null;
    setMessages((current) => [...current, {
      role: "assistant",
      text: response.ok ? `${decision === "approved" ? "Approved" : "Rejected"} operation ${operationId}.` : body?.error ?? `operation decision failed (${response.status})`,
      surface: "dashboard",
      at: new Date().toISOString(),
    }]);
  }

  async function send(messageText?: string) {
    const message = (messageText ?? input).trim();
    if (!message || busy) return;
    if (attachments.some((attachment) => attachment.state !== "ready")) return;
    const submittedAttachments = attachments;
    setInput("");
    setAttachments([]);
    setBusy(true);
    setMessages((m) => [...m, { role: "user", text: message, attachments: submittedAttachments, surface: "dashboard", at: new Date().toISOString() }]);
    try {
      const result = await chat.send(message, submittedAttachments.map((attachment) => attachment.attachmentId));
      const latestJob = result.jobUpdates.at(-1)?.jobId;
      if (latestJob) void openJob(latestJob);
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", text: e instanceof Error ? e.message : String(e), surface: "dashboard", at: new Date().toISOString() }]);
    } finally {
      setBusy(false);
    }
  }

  // Rendered stream: sessions with day dividers between different days.
  let lastDay: string | null = null;
  const rendered = visible.map((s) => {
    const showDivider = s.day !== lastDay;
    lastDay = s.day;
    return { session: s, showDivider };
  });

  return (
    <div className="relative flex h-screen">
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <div>
            <h1 className="text-sm font-semibold tracking-tight">Console</h1>
            <p className="text-[11px] text-zinc-400">
              {activeSessionId ? "Viewing a past conversation" : "One surface for jobs, drafts, approvals — the agent routes it."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {activeSessionId && (
              <button
                onClick={() => setActiveSessionId(null)}
                className="rounded-full border border-zinc-300 px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                ← Back to current
              </button>
            )}
            <button
              onClick={() => setHistoryOpen((o) => !o)}
              aria-label="Toggle history"
              className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
                historyOpen ? "bg-zinc-900 text-white dark:bg-white dark:text-black" : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-900 dark:hover:text-zinc-200"
              }`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-5 w-5">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </button>
          </div>
        </header>

        <div ref={scrollRef} className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 sm:px-6">
          {!loaded && <div className="mx-auto w-full max-w-2xl py-8 text-center text-xs text-zinc-400">Loading conversations…</div>}
          {loaded && rendered.length === 0 && (
            <div className="mx-auto w-full max-w-2xl py-16 text-center text-sm text-zinc-400">
              No conversations yet — say something below.
            </div>
          )}
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
            {rendered.map(({ session, showDivider }, idx) => (
              <div key={session.id}>
                {showDivider && (
                  <div className="my-4 flex items-center gap-3">
                    <div className="h-px flex-1 bg-zinc-200 dark:border-zinc-800 dark:bg-zinc-800" />
                    <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                      {dayLabel(session.day)} · {session.surface === "telegram" ? "Telegram" : "Dashboard"}
                      {activeSessionId === session.id ? "" : ""}
                    </span>
                    <div className="h-px flex-1 bg-zinc-200 dark:border-zinc-800 dark:bg-zinc-800" />
                  </div>
                )}
                {idx > 0 && !showDivider && <div className="h-2" />}
                <div className="flex flex-col gap-3">
                  {session.messages.map((m, i) => (
                    <Bubble key={`${session.id}-${i}`} m={m} onOpenJob={openJob} onDecide={decide} onOperationDecision={decideOperation} />
                  ))}
                </div>
              </div>
            ))}
            {chat.run?.status === "running" && (
              <Bubble
                m={{ role: "assistant", text: chat.run.text, run: chat.run, surface: "dashboard", at: new Date().toISOString() }}
                onOpenJob={openJob}
                onDecide={decide}
                onOperationDecision={decideOperation}
              />
            )}
            {busy && !chat.run && <div className="self-start text-xs text-zinc-400">working…</div>}
          </div>
        </div>

        <footer className="border-t border-zinc-200 px-4 py-3 sm:px-6 dark:border-zinc-800">
          <div className="mx-auto w-full max-w-2xl">
            <div className="mb-2">
              <AttachmentComposer attachments={attachments} onChange={setAttachments} disabled={busy} />
            </div>
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
                disabled={busy || !input.trim() || attachments.some((attachment) => attachment.state !== "ready")}
                aria-label="Send"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-black"
              >
                <SendIcon />
              </button>
            </div>
          </div>
        </footer>
      </section>

      {/* History drawer */}
      {historyOpen && (
        <aside className="absolute inset-y-0 right-0 z-30 w-80 overflow-y-auto border-l border-zinc-200 bg-white/95 p-4 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95 lg:w-96">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Past conversations</h2>
            <button onClick={() => setHistoryOpen(false)} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200" aria-label="Close history">✕</button>
          </div>
          {sessions.length === 0 ? (
            <p className="text-xs text-zinc-400">No conversations yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {[...sessions].reverse().map((s: ChatSession) => {
                const isActive = activeSessionId === s.id;
                const isCurrent = !activeSessionId && s.id === sessions.at(-1)?.id;
                return (
                  <li key={s.id}>
                    <button
                      onClick={() => {
                        setActiveSessionId(isActive || isCurrent ? null : s.id);
                        setHistoryOpen(false);
                      }}
                      className={`w-full rounded-lg border p-3 text-left transition-colors ${
                        isActive
                          ? "border-zinc-900 bg-zinc-100 dark:border-white dark:bg-zinc-900"
                          : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                          {dayLabel(s.day)}
                        </span>
                        <span className={`rounded px-1.5 py-px text-[9px] font-semibold uppercase ${
                          s.surface === "telegram"
                            ? "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-400"
                            : "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400"
                        }`}>
                          {s.surface === "telegram" ? "TG" : "Web"}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-700 dark:text-zinc-300">
                        {sessionPreview(s)}
                      </p>
                      <p className="mt-1 text-[10px] text-zinc-400">
                        {s.messages.length} message{s.messages.length > 1 ? "s" : ""}
                        {isCurrent ? " · ongoing" : ""}
                        {s.startedAt ? ` · ${new Date(s.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      )}

      {detail && (
        <aside className="hidden w-[420px] shrink-0 overflow-y-auto border-l border-zinc-200 p-4 lg:block xl:w-[520px] dark:border-zinc-800">
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
