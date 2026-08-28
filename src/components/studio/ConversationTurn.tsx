"use client";

import { useState } from "react";
import { AttachmentCard, MessageContent } from "@/components/a2ui/HarmoniaElements";
import { HarmoniaA2uiHost } from "@/components/a2ui/HarmoniaCatalog";
import { latestSurfaceOperations } from "@/lib/a2ui/surfaceSlots";
import { surfaceRevisionRequest } from "@/lib/a2ui/workspaceActions";
import type { StudioConversationMessage } from "@/lib/studio/conversationModel";
import { AgentRunSummary } from "./AgentRunSummary";
import { StudioFailure } from "./StudioStates";

interface ConversationTurnProps {
  message: StudioConversationMessage;
  onActivateArtifact?: (artifactId: string) => void;
  onActivateJob?: (jobId: string) => void;
  onRequestSurfaceRevision?: (message: string) => Promise<void> | void;
  live?: boolean;
}

function formatTime(value?: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ConversationTurn({ message, onActivateArtifact, onActivateJob, onRequestSurfaceRevision, live = false }: ConversationTurnProps) {
  const [actionError, setActionError] = useState<string | null>(null);
  const user = message.role === "user";
  const jobs = [message.data?.job, ...(message.data?.jobs ?? [])].filter(Boolean) as NonNullable<typeof message.data>["job"][];
  let conversationOperations: unknown[] = [];
  let protocolError: string | null = null;
  try {
    conversationOperations = message.run?.operations.length
      ? latestSurfaceOperations(message.run.operations, "conversation")
      : [];
  } catch (error) {
    protocolError = error instanceof Error ? error.message : String(error);
  }
  return (
    <article
      className={`studio-turn flex flex-col ${user ? "items-end" : "items-start"}`}
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 180px" }}
      data-role={message.role}
    >
      <div className={`mb-1 flex items-center gap-2 px-1 font-mono text-[7px] text-[#8b877f] ${user ? "justify-end" : ""}`}>
        <span>{user ? "You" : "Harmonia"}</span>
        {message.surface === "telegram" ? <span className="bg-[#2aa7df]/15 px-1.5 py-0.5 text-[#12668b]">Telegram</span> : null}
        {formatTime(message.at) ? <time>{formatTime(message.at)}</time> : null}
      </div>
      <div className={user
        ? "max-w-[88%] rounded-[14px_14px_4px_14px] bg-[#11110f] px-[11px] py-2.5 text-[10px] leading-[1.5] text-white"
        : "max-w-[92%] rounded-[14px_14px_14px_4px] border border-black/10 bg-white px-[11px] py-2.5 text-[10px] leading-[1.5] text-[#25231f]"}
      >
        <MessageContent text={message.text} />
      </div>
      {conversationOperations.length ? <HarmoniaA2uiHost operations={conversationOperations} live={live} className="mt-2 flex w-full flex-col gap-2" onAction={(action) => {
        if (action.name !== "request_surface_revision") {
          setActionError(`Unknown A2UI action: ${action.name}`);
          return;
        }
        const jobId = String(action.context.jobId ?? "");
        const draftId = String(action.context.draftId ?? "");
        if (!jobId || !draftId || !onRequestSurfaceRevision) {
          setActionError("The generated revision request did not contain stable job and draft references.");
          return;
        }
        setActionError(null);
        void onRequestSurfaceRevision(surfaceRevisionRequest(jobId, draftId));
      }} /> : null}
      {actionError ? <div className="mt-2 w-full"><StudioFailure message={`A2UI action blocked: ${actionError}`} permanent /></div> : null}
      {protocolError ? <div className="mt-2 w-full"><StudioFailure message={`A2UI protocol error: ${protocolError}`} permanent /></div> : null}

      {message.attachments?.length ? (
        <div className="mt-2 grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
          {message.attachments.map((attachment) => <AttachmentCard key={attachment.attachmentId} attachment={attachment} />)}
        </div>
      ) : null}

      {jobs.length ? (
        <div className="mt-3 grid w-full gap-2">
          {jobs.map((job) => job ? (
            <button key={job.id} type="button" onClick={() => onActivateJob?.(job.id)} className="group flex w-full items-center gap-2 rounded-[10px] border border-black/10 bg-[#f2eee5] p-2 text-left transition hover:border-[#5165ff]">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-[#d8ff3e] text-sm">↗</span>
              <span className="min-w-0 flex-1"><span className="block truncate text-[9px] font-bold">{job.title ?? "Untitled content job"}</span><span className="font-mono text-[7px] text-black/45">{job.id} · {job.stage} · {job.status}</span></span>
              <span className="text-black/35 group-hover:text-[#3157ff]">Open</span>
            </button>
          ) : null)}
        </div>
      ) : null}

      {message.data?.drafts?.length ? (
        <div className="mt-3 grid w-full gap-2">
          {message.data.drafts.map((draft) => (
            <button
              key={draft.id}
              type="button"
              data-artifact-id={`draft:${draft.id}`}
              onClick={() => onActivateArtifact?.(`draft:${draft.id}`)}
              className="group w-full rounded-[10px] border border-black/10 bg-[#f2eee5] p-2 text-left transition hover:border-[#ff765f]"
            >
              <span className="mb-1 flex items-center justify-between font-mono text-[7px] text-black/45"><span>{draft.platform} draft</span><span>{draft.text.length}/280</span></span>
              <span className="block text-[9px] leading-[1.5] text-[#25231f]">{draft.text}</span>
              <span className={`mt-2 inline-block rounded-full px-2 py-1 font-mono text-[7px] ${draft.valid ? "bg-[#d8ff3e] text-[#283600]" : "bg-[#ff765f]/15 text-[#9f2c11]"}`}>{draft.valid ? "Reviewed" : "Needs attention"}</span>
            </button>
          ))}
        </div>
      ) : null}

      {message.run ? <div className="mt-3 w-full"><AgentRunSummary run={message.run} /></div> : null}
    </article>
  );
}
