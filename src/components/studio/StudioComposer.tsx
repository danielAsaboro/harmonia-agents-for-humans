"use client";

import type { Dispatch, SetStateAction } from "react";
import { AttachmentComposer, type ComposerAttachment } from "@/components/a2ui/AttachmentComposer";
import { SendIcon } from "@/components/icons";

const MODES = ["Explore", "Draft", "Remix", "Produce"] as const;

interface StudioComposerProps {
  value: string;
  onChange: (value: string) => void;
  attachments: ComposerAttachment[];
  onAttachmentsChange: Dispatch<SetStateAction<ComposerAttachment[]>>;
  onSend: (message?: string) => void | Promise<void>;
  busy: boolean;
}

export function StudioComposer({ value, onChange, attachments, onAttachmentsChange, onSend, busy }: StudioComposerProps) {
  const blocked = busy || !value.trim() || attachments.some((attachment) => attachment.state !== "ready");
  return (
    <div className="border-t border-black/10 bg-[#f4f0e8]/95 px-4 pb-4 pt-3 backdrop-blur">
      <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
        {MODES.map((mode) => (
          <button key={mode} type="button" disabled={busy} onClick={() => onChange(`${mode}: ${value}`.trim())} className="shrink-0 rounded-full border border-black/15 bg-white/55 px-3 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-black/55 hover:border-black hover:text-black disabled:opacity-40">{mode}</button>
        ))}
      </div>
      {attachments.length ? <div className="mb-2"><AttachmentComposer attachments={attachments} onChange={onAttachmentsChange} disabled={busy} /></div> : null}
      <div className="flex items-end gap-2 rounded-[22px] border-2 border-[#161512] bg-[#fffdf7] p-2 shadow-[4px_4px_0_rgba(22,21,18,0.12)] focus-within:shadow-[4px_4px_0_#3157ff]">
        <AttachmentComposer attachments={[]} onChange={onAttachmentsChange} disabled={busy || attachments.length >= 20} />
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!blocked) void onSend();
            }
          }}
          rows={1}
          placeholder="Shape the story, request a format, or ask what needs approval…"
          className="max-h-36 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-sm leading-5 outline-none placeholder:text-black/35"
        />
        <button type="button" aria-label="Send message" disabled={blocked} onClick={() => void onSend()} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#161512] text-white transition hover:scale-105 disabled:opacity-30"><SendIcon /></button>
      </div>
      <p className="mt-2 text-center text-[9px] font-semibold uppercase tracking-[0.12em] text-black/35">Publishing and material actions still require approval</p>
    </div>
  );
}
