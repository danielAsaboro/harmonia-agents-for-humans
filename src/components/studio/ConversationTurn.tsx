import { AttachmentCard, MessageContent } from "@/components/a2ui/HarmoniaElements";
import type { StudioConversationMessage } from "@/lib/studio/conversationModel";
import { AgentRunSummary } from "./AgentRunSummary";

interface ConversationTurnProps {
  message: StudioConversationMessage;
  onActivateArtifact?: (artifactId: string) => void;
  onActivateJob?: (jobId: string) => void;
}

function formatTime(value?: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ConversationTurn({ message, onActivateArtifact, onActivateJob }: ConversationTurnProps) {
  const user = message.role === "user";
  const jobs = [message.data?.job, ...(message.data?.jobs ?? [])].filter(Boolean) as NonNullable<typeof message.data>["job"][];
  return (
    <article
      className={`studio-turn flex flex-col ${user ? "items-end" : "items-stretch"}`}
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 180px" }}
      data-role={message.role}
    >
      <div className={`mb-1 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.13em] text-black/35 ${user ? "justify-end" : ""}`}>
        <span>{user ? "You" : "Harmonia"}</span>
        {message.surface === "telegram" ? <span className="bg-[#2aa7df]/15 px-1.5 py-0.5 text-[#12668b]">Telegram</span> : null}
        {formatTime(message.at) ? <time>{formatTime(message.at)}</time> : null}
      </div>
      <div className={user
        ? "max-w-[88%] rounded-[22px_22px_5px_22px] bg-[#161512] px-4 py-3 text-white shadow-sm"
        : "max-w-[96%] border-l-2 border-black/15 pl-4 text-[#25231f]"}
      >
        <MessageContent text={message.text} />
      </div>

      {message.attachments?.length ? (
        <div className="mt-3 grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
          {message.attachments.map((attachment) => <AttachmentCard key={attachment.attachmentId} attachment={attachment} />)}
        </div>
      ) : null}

      {jobs.length ? (
        <div className="mt-3 grid w-full gap-2">
          {jobs.map((job) => job ? (
            <button key={job.id} type="button" onClick={() => onActivateJob?.(job.id)} className="group flex w-full items-center gap-3 border border-black/15 bg-white/65 p-3 text-left transition hover:-translate-y-0.5 hover:border-[#3157ff] hover:shadow-[4px_4px_0_#3157ff]">
              <span className="grid h-9 w-9 place-items-center bg-[#d9ff43] text-lg">↗</span>
              <span className="min-w-0 flex-1"><span className="block truncate font-serif text-base">{job.title ?? "Untitled content job"}</span><span className="font-mono text-[10px] uppercase text-black/45">{job.id} · {job.stage} · {job.status}</span></span>
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
              className="group w-full border border-black/15 bg-[#fffdf7] p-4 text-left transition hover:border-[#ff5c35] hover:shadow-[4px_4px_0_#ff5c35]"
            >
              <span className="mb-2 flex items-center justify-between text-[10px] font-black uppercase tracking-[0.16em] text-black/40"><span>{draft.platform} draft</span><span>{draft.text.length}/280</span></span>
              <span className="block text-sm leading-6 text-[#25231f]">{draft.text}</span>
              <span className={`mt-3 inline-block px-2 py-1 text-[9px] font-black uppercase tracking-wider ${draft.valid ? "bg-[#d9ff43] text-[#283600]" : "bg-[#ff5c35]/15 text-[#9f2c11]"}`}>{draft.valid ? "Reviewed" : "Needs attention"}</span>
            </button>
          ))}
        </div>
      ) : null}

      {message.run ? <div className="mt-3 w-full"><AgentRunSummary run={message.run} /></div> : null}
    </article>
  );
}
