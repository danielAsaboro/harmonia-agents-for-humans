"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { AttachmentComposer, type ComposerAttachment } from "@/components/a2ui/AttachmentComposer";
import { SendIcon } from "@/components/icons";
import { BrandLibrarySelector } from "./BrandLibrarySelector";
import { OutputIntentSelector } from "./OutputIntentSelector";
import type { OutputKind } from "@/lib/types";

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
  const [library, setLibrary] = useState("");
  const [outputs, setOutputs] = useState<OutputKind[]>(["x_post"]);
  const blocked = busy || (!value.trim() && !library) || outputs.length === 0 || attachments.some((attachment) => attachment.state !== "ready");
  const send = () => onSend(`${value.trim() || "Create content from the selected brand library."}${library ? `\nUse brand library "${library}".` : ""}\nDesired outputs: ${outputs.join(", ")}.`);
  return (
    <div className="shrink-0 border-t border-black/10 bg-[#e9e5dc] px-[15px] pb-3 pt-2.5 lg:min-h-[125px]">
      <div className="mb-2 hidden gap-1.5 overflow-x-auto pb-1 xl:flex">
        {MODES.map((mode) => (
          <button key={mode} type="button" disabled={busy} onClick={() => onChange(`${mode}: ${value}`.trim())} className="shrink-0 rounded-full border border-black/15 bg-white/55 px-3 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-black/55 hover:border-black hover:text-black disabled:opacity-40">{mode}</button>
        ))}
      </div>
      <div className="mb-2 flex items-center gap-3 overflow-x-auto"><BrandLibrarySelector selected={library} onSelect={setLibrary} disabled={busy} /><OutputIntentSelector selected={outputs} onChange={setOutputs} disabled={busy} /></div>
      {attachments.length ? <div className="mb-2"><AttachmentComposer attachments={attachments} onChange={onAttachmentsChange} disabled={busy} /></div> : null}
      <div className="flex items-end gap-2 rounded-[14px] border border-[#11110f] bg-white p-1.5 shadow-[3px_3px_0_#11110f]">
        <AttachmentComposer attachments={[]} onChange={onAttachmentsChange} disabled={busy || attachments.length >= 20} />
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!blocked) void send();
            }
          }}
          rows={1}
          placeholder="Shape the story, request a format, or ask what needs approval…"
          className="max-h-28 min-h-8 flex-1 resize-none bg-transparent px-1 py-2 text-[10px] leading-4 outline-none placeholder:text-black/40"
        />
        <button type="button" aria-label="Send message" disabled={blocked} onClick={() => void send()} className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#11110f] text-white transition hover:scale-105 disabled:opacity-30"><SendIcon /></button>
      </div>
      <p className="mt-2 text-center font-mono text-[7px] text-black/40">Working set linked · approval boundary on</p>
    </div>
  );
}
