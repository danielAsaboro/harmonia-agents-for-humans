"use client";

import { useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ComposerAttachment } from "@/components/a2ui/AttachmentComposer";
import type { ChatRunState } from "@/lib/a2ui/chatReducer";
import type { StudioChapter, StudioConversationMessage } from "@/lib/studio/conversationModel";
import { ConversationTurn } from "./ConversationTurn";
import { StudioComposer } from "./StudioComposer";
import { StudioEmpty, StudioLoading } from "./StudioStates";

interface ConversationPaneProps {
  chapters: StudioChapter[];
  liveRun?: ChatRunState | null;
  loaded: boolean;
  input: string;
  onInputChange: (value: string) => void;
  attachments: ComposerAttachment[];
  onAttachmentsChange: Dispatch<SetStateAction<ComposerAttachment[]>>;
  busy: boolean;
  onSend: (message?: string) => void | Promise<void>;
  onActivateArtifact: (artifactId: string) => void;
  onActivateJob: (jobId: string) => void;
}

export function ConversationPane(props: ConversationPaneProps) {
  const [activeChapter, setActiveChapter] = useState(props.chapters.at(-1)?.key ?? "discovery");
  const [query, setQuery] = useState("");
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const visibleChapters = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return props.chapters;
    return props.chapters.flatMap((chapter) => {
      const messages = chapter.messages.filter((message) => `${message.text} ${message.data?.drafts?.map((draft) => draft.text).join(" ") ?? ""}`.toLowerCase().includes(needle));
      return messages.length ? [{ ...chapter, messages }] : [];
    });
  }, [props.chapters, query]);

  function goToChapter(key: StudioChapter["key"]) {
    setActiveChapter(key);
    document.getElementById(`chapter-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const liveMessage: StudioConversationMessage | null = props.liveRun?.status === "running"
    ? { role: "assistant", text: props.liveRun.text, run: props.liveRun }
    : null;

  return (
    <section className="flex h-full min-h-0 flex-col border-r border-black/10 bg-[#f4f0e8]">
      <header className="border-b border-black/10 px-4 pb-3 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div><p className="text-[10px] font-black uppercase tracking-[0.2em] text-[#3157ff]">Live editorial room</p><h1 className="mt-0.5 font-serif text-2xl leading-none">Make the idea travel.</h1></div>
          <label className="relative w-28 shrink-0"><span className="sr-only">Search conversation</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" className="w-full rounded-full border border-black/15 bg-white/55 px-3 py-1.5 text-xs outline-none focus:border-[#3157ff]" /></label>
        </div>
        <nav className="mt-4 flex gap-1 overflow-x-auto" aria-label="Conversation chapters">
          {props.chapters.map((chapter, index) => (
            <button key={chapter.key} type="button" onClick={() => goToChapter(chapter.key)} aria-current={activeChapter === chapter.key ? "step" : undefined} className={`shrink-0 border px-2.5 py-1.5 text-[9px] font-black uppercase tracking-[0.12em] ${activeChapter === chapter.key ? "border-[#161512] bg-[#161512] text-white" : "border-black/15 text-black/45 hover:text-black"}`}><span className="mr-1 opacity-55">0{index + 1}</span>{chapter.label}</button>
          ))}
        </nav>
      </header>

      <div
        ref={scrollRef}
        className="relative flex-1 overflow-y-auto overscroll-contain px-4 py-5"
        onScroll={(event) => {
          const node = event.currentTarget;
          setAwayFromLatest(node.scrollHeight - node.scrollTop - node.clientHeight > 240);
        }}
      >
        {!props.loaded ? <StudioLoading label="Loading conversation" /> : null}
        {props.loaded && visibleChapters.length === 0 ? <StudioEmpty title={query ? "No matching turns" : "Start with the raw idea"}>{query ? "Try a different phrase." : "Talk it through, attach source material, or ask Harmonia to explore a narrative."}</StudioEmpty> : null}
        <div className="space-y-8">
          {visibleChapters.map((chapter, chapterIndex) => {
            const hidden = chapter.messages.length > 6 ? chapter.messages.slice(0, -6) : [];
            const recent = hidden.length ? chapter.messages.slice(-6) : chapter.messages;
            return (
              <section key={chapter.key} id={`chapter-${chapter.key}`} className="scroll-mt-4" aria-labelledby={`chapter-title-${chapter.key}`}>
                <div className="mb-4 flex items-end gap-3 border-b border-black/15 pb-2"><span className="font-mono text-xs text-[#ff5c35]">0{chapterIndex + 1}</span><div className="min-w-0"><h2 id={`chapter-title-${chapter.key}`} className="font-serif text-xl">{chapter.label}</h2><p className="truncate text-[10px] text-black/40">{chapter.summary}</p></div></div>
                {hidden.length ? <details className="mb-5 border-y border-black/10 py-2"><summary className="cursor-pointer text-[10px] font-black uppercase tracking-[0.14em] text-black/45">Show {hidden.length} earlier turns</summary><div className="mt-5 space-y-6">{hidden.map((message, index) => <ConversationTurn key={`${message.at ?? "turn"}-${index}`} message={message} onActivateArtifact={props.onActivateArtifact} onActivateJob={props.onActivateJob} />)}</div></details> : null}
                <div className="space-y-6">{recent.map((message, index) => <ConversationTurn key={`${message.at ?? "turn"}-${index}`} message={message} onActivateArtifact={props.onActivateArtifact} onActivateJob={props.onActivateJob} />)}</div>
              </section>
            );
          })}
          {liveMessage ? <ConversationTurn message={liveMessage} onActivateArtifact={props.onActivateArtifact} onActivateJob={props.onActivateJob} /> : null}
        </div>
        {awayFromLatest ? <button type="button" onClick={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })} className="sticky bottom-3 left-1/2 mt-4 -translate-x-1/2 rounded-full bg-[#3157ff] px-4 py-2 text-xs font-bold text-white shadow-xl">↓ Return to latest</button> : null}
      </div>

      <StudioComposer value={props.input} onChange={props.onInputChange} attachments={props.attachments} onAttachmentsChange={props.onAttachmentsChange} onSend={props.onSend} busy={props.busy} />
    </section>
  );
}
