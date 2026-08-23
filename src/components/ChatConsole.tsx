"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { ComposerAttachment } from "@/components/a2ui/AttachmentComposer";
import type { TimelineEvent } from "@/components/Timeline";
import type { JobFull, Receipt } from "@/components/jobTypes";
import { ConversationPane } from "@/components/studio/ConversationPane";
import { StudioShell } from "@/components/studio/StudioShell";
import { WorkingCanvas } from "@/components/studio/WorkingCanvas";
import { useHarmoniaChat } from "@/hooks/useHarmoniaChat";
import type { ChatRunState } from "@/lib/a2ui/chatReducer";
import { historyRunState } from "@/lib/a2ui/historyReplay";
import { latestSurfaceOperations } from "@/lib/a2ui/surfaceSlots";
import { apiFetch } from "@/lib/clientApi";
import { dayLabel, groupSessions, sessionPreview, type ConsoleMessage } from "@/lib/chatSessions";
import { activeJobIdForConversation, buildStudioChapters } from "@/lib/studio/conversationModel";

export interface JobDetailBundle {
  job: JobFull;
  events: TimelineEvent[];
  receipts: Receipt[];
}

interface StudioConsoleViewProps {
  messages: ConsoleMessage[];
  loaded: boolean;
  detail: JobDetailBundle | null;
  detailLoading?: boolean;
  detailError?: string | null;
  liveRun: ChatRunState | null;
  input: string;
  onInputChange: (value: string) => void;
  attachments: ComposerAttachment[];
  onAttachmentsChange: Dispatch<SetStateAction<ComposerAttachment[]>>;
  busy: boolean;
  onSend: (message?: string) => void | Promise<void>;
  onOpenJob: (jobId: string) => void;
  selectedArtifactId: string | null;
  onSelectedArtifactChange: (artifactId: string | null) => void;
  mobilePane: "conversation" | "canvas";
  onMobilePaneChange: (pane: "conversation" | "canvas") => void;
  onDecide: (jobId: string, actionId: string, decision: "approved" | "rejected") => Promise<void> | void;
  onOperationDecision: (operationId: string, decision: "approved" | "rejected") => Promise<void> | void;
  onRetryJob?: () => void;
  historyAccessory?: ReactNode;
}

export function StudioConsoleView(props: StudioConsoleViewProps) {
  const chapters = useMemo(() => buildStudioChapters(props.messages), [props.messages]);
  const workspace = props.detail?.job;
  const campaignTitle = workspace?.ingestedTitle || workspace?.config.brief || workspace?.config.youtubeUrl || "Untitled campaign";
  const artifactCount = workspace ? workspace.drafts.length + (workspace.assets?.length ?? 0) : 0;
  const lastPersistedRunMessage = [...props.messages].reverse().find((message) => message.run);
  const persistedRunMatchesCanvas = Boolean(
    lastPersistedRunMessage?.run && props.detail?.job.id && (
      lastPersistedRunMessage.data?.jobId === props.detail.job.id ||
      lastPersistedRunMessage.data?.job?.id === props.detail.job.id ||
      lastPersistedRunMessage.run.jobUpdates.some((update) => update.jobId === props.detail?.job.id)
    ),
  );
  const canvasRun = props.liveRun ?? (persistedRunMatchesCanvas ? lastPersistedRunMessage?.run : null) ?? null;
  let generatedWorkspaceCount = 0;
  try {
    generatedWorkspaceCount = canvasRun?.operations.length && latestSurfaceOperations(canvasRun.operations, "canvas").length ? 1 : 0;
  } catch {
    generatedWorkspaceCount = 0;
  }
  const approvalCount = workspace?.actions.filter((action) => action.approvalState === "pending" && action.state === "planned").length ?? 0;
  return (
    <StudioShell
      mobilePane={props.mobilePane}
      onMobilePaneChange={props.onMobilePaneChange}
      canvasBadge={generatedWorkspaceCount}
      approvalBadge={approvalCount}
      conversation={<ConversationPane chapters={chapters} liveRun={props.liveRun} loaded={props.loaded} input={props.input} onInputChange={props.onInputChange} attachments={props.attachments} onAttachmentsChange={props.onAttachmentsChange} busy={props.busy} onSend={props.onSend} onActivateArtifact={(artifactId) => { props.onSelectedArtifactChange(artifactId); props.onMobilePaneChange("canvas"); }} onActivateJob={(jobId) => { props.onOpenJob(jobId); props.onMobilePaneChange("canvas"); }} headerAccessory={props.historyAccessory} campaignTitle={campaignTitle} artifactCount={artifactCount} />}
      canvas={<WorkingCanvas job={props.detail?.job ?? null} events={props.detail?.events ?? []} receipts={props.detail?.receipts ?? []} loading={props.detailLoading} error={props.detailError} selectedArtifactId={props.selectedArtifactId} onSelectedArtifactChange={props.onSelectedArtifactChange} onRetry={props.onRetryJob} operations={canvasRun?.operations ?? []} approvalBusy={props.busy} onDecide={props.onDecide} onOperationDecision={props.onOperationDecision} onRequestSurfaceRevision={props.onSend} />}
    />
  );
}

export default function ChatConsole() {
  const [messages, setMessages] = useState<ConsoleMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [detail, setDetail] = useState<JobDetailBundle | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<"conversation" | "canvas">("conversation");
  const completedRuns = useRef(new Set<string>());
  const detailRequest = useRef<AbortController | null>(null);
  const chat = useHarmoniaChat();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      fetch("/api/chat/history?limit=300", { cache: "no-store" })
        .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
        .then(async (body: { messages: Array<{ id?: string; role: string; text: string; data?: ConsoleMessage["data"]; surface?: string; at?: string | null }> }) => {
          const hydrated = await Promise.all(body.messages.map(async (message): Promise<ConsoleMessage> => {
            let run: ChatRunState | undefined;
            if (message.role === "assistant" && message.data?.chatRunId) {
              try {
                const response = await fetch(`/api/chat/runs/${message.data.chatRunId}/events?after=-1`, { cache: "no-store" });
                const replay = await response.json().catch(() => null) as { events?: unknown[]; error?: string } | null;
                if (!response.ok) throw new Error(replay?.error ?? `HTTP ${response.status}`);
                run = historyRunState(message.data.chatRunId, Array.isArray(replay?.events) ? replay.events : []);
              } catch (error) {
                run = historyRunState(message.data.chatRunId, [{ type: "run_failed", runId: message.data.chatRunId, sequence: 0, failedAt: new Date().toISOString(), error: `Chat history replay unavailable: ${error instanceof Error ? error.message : String(error)}`, permanent: false }]);
              }
            }
            return { id: message.id, role: message.role === "user" ? "user" : "assistant", text: message.text, data: message.data, surface: message.surface, at: message.at, attachments: message.data?.attachments?.map((attachment) => ({ ...attachment, progress: 100 })), run };
          }));
          setMessages(hydrated);
        })
        .catch(() => setMessages([{ id: "welcome", role: "assistant", text: "Bring me a raw idea, a brief, or source media. We can shape the narrative together before anything reaches approval." }]))
        .finally(() => setLoaded(true));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const run = chat.run;
    if (!run || run.status === "running" || completedRuns.current.has(run.runId)) return;
    completedRuns.current.add(run.runId);
    setMessages((current) => [...current, { id: `run-${run.runId}`, role: "assistant", text: run.status === "complete" ? run.text : run.error ?? "Chat run failed", run, surface: "dashboard", at: new Date().toISOString() }]);
  }, [chat.run]);

  const sessions = useMemo(() => groupSessions(messages), [messages]);
  const visibleMessages = useMemo(() => {
    const selected = activeSessionId ? sessions.find((session) => session.id === activeSessionId) : sessions.at(-1);
    return selected?.messages ?? messages;
  }, [activeSessionId, messages, sessions]);
  const activeJobId = activeJobIdForConversation(visibleMessages);

  const openJob = useCallback(async (jobId: string) => {
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}`, { cache: "no-store", signal: controller.signal });
      const body = await response.json().catch(() => null) as { job?: JobFull; events?: TimelineEvent[]; receipts?: Receipt[]; assets?: NonNullable<JobFull["assets"]>; error?: string } | null;
      if (!response.ok || !body?.job) throw new Error(body?.error ?? `Unable to load job (${response.status})`);
      if (!controller.signal.aborted) setDetail({ job: { ...body.job, assets: body.assets ?? body.job.assets ?? [] }, events: body.events ?? [], receipts: body.receipts ?? [] });
    } catch (error) {
      if (!controller.signal.aborted) setDetailError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!controller.signal.aborted) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeJobId && detail?.job.id !== activeJobId) void openJob(activeJobId);
  }, [activeJobId, detail?.job.id, openJob]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams(window.location.search);
      const jobId = query.get("job");
      if (!jobId) return;
      void openJob(jobId);
      window.history.replaceState({}, "", window.location.pathname);
      if (query.get("item")) setInput("Refine the post from this job — make it punchier and suggest a better posting time.");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [openJob]);

  async function decide(jobId: string, actionId: string, decision: "approved" | "rejected") {
    setBusy(true);
    try {
      const response = await apiFetch(`/api/jobs/${jobId}/actions/${actionId}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) });
      if (!response.ok) throw new Error(`Decision failed (${response.status})`);
      setMessages((current) => [...current, { id: `decision-${Date.now()}`, role: "assistant", text: `${decision === "approved" ? "Approved" : "Rejected"} action ${actionId} on job ${jobId}.`, surface: "dashboard", at: new Date().toISOString() }]);
      await openJob(jobId);
    } finally { setBusy(false); }
  }

  async function decideOperation(operationId: string, decision: "approved" | "rejected") {
    setBusy(true);
    try {
      const response = await apiFetch(`/api/chat/operations/${operationId}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? `Operation decision failed (${response.status})`);
      setMessages((current) => [...current, { id: `operation-${Date.now()}`, role: "assistant", text: `${decision === "approved" ? "Approved" : "Rejected"} operation ${operationId}.`, surface: "dashboard", at: new Date().toISOString() }]);
    } finally { setBusy(false); }
  }

  async function send(messageText?: string) {
    const message = (messageText ?? input).trim();
    if (!message || busy || attachments.some((attachment) => attachment.state !== "ready")) return;
    const submittedAttachments = attachments;
    setInput(""); setAttachments([]); setBusy(true); setActiveSessionId(null);
    setMessages((current) => [...current, { id: `operator-${Date.now()}`, role: "user", text: message, attachments: submittedAttachments, surface: "dashboard", at: new Date().toISOString() }]);
    try {
      const result = await chat.send(message, submittedAttachments.map((attachment) => attachment.attachmentId));
      const latestJobId = result.jobUpdates.at(-1)?.jobId;
      if (latestJobId) await openJob(latestJobId);
    } catch (error) {
      setMessages((current) => [...current, { id: `failure-${Date.now()}`, role: "assistant", text: error instanceof Error ? error.message : String(error), surface: "dashboard", at: new Date().toISOString() }]);
    } finally { setBusy(false); }
  }

  const historyAccessory = sessions.length > 1 ? <select value={activeSessionId ?? sessions.at(-1)?.id ?? ""} onChange={(event) => setActiveSessionId(event.target.value === sessions.at(-1)?.id ? null : event.target.value)} className="max-w-28 rounded-full border border-black/15 bg-white/55 px-2 py-1.5 text-[10px] font-bold outline-none" aria-label="Past conversations">{sessions.map((session) => <option key={session.id} value={session.id}>{dayLabel(session.day)} · {sessionPreview(session)}</option>)}</select> : null;

  return <StudioConsoleView messages={visibleMessages} loaded={loaded} detail={detail} detailLoading={detailLoading} detailError={detailError} liveRun={chat.run?.status === "running" ? chat.run : null} input={input} onInputChange={setInput} attachments={attachments} onAttachmentsChange={setAttachments} busy={busy} onSend={send} onOpenJob={openJob} selectedArtifactId={selectedArtifactId} onSelectedArtifactChange={setSelectedArtifactId} mobilePane={mobilePane} onMobilePaneChange={setMobilePane} onDecide={decide} onOperationDecision={decideOperation} onRetryJob={detail?.job.failure ? async () => { await apiFetch(`/api/jobs/${detail.job.id}/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }); await openJob(detail.job.id); } : undefined} historyAccessory={historyAccessory} />;
}
