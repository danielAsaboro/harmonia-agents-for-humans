"use client";

import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import styles from "./StudioShell.module.css";

export const DEFAULT_CONVERSATION_PERCENT = 40;
const SPLIT_KEY = "harmonia:studio-split";

export function clampConversationPercent(value: number): number {
  return Math.min(52, Math.max(32, Math.round(value)));
}

interface StudioShellProps {
  conversation: ReactNode;
  canvas: ReactNode;
  mobilePane: "conversation" | "canvas";
  onMobilePaneChange: (pane: "conversation" | "canvas") => void;
}

export function StudioShell({ conversation, canvas, mobilePane, onMobilePaneChange }: StudioShellProps) {
  const rootRef = useRef<HTMLElement>(null);
  const [conversationPercent, setConversationPercent] = useState(DEFAULT_CONVERSATION_PERCENT);

  useEffect(() => {
    const saved = Number.parseFloat(window.localStorage.getItem(SPLIT_KEY) ?? "");
    if (!Number.isFinite(saved)) return;
    const timer = window.setTimeout(() => setConversationPercent(clampConversationPercent(saved)), 0);
    return () => window.clearTimeout(timer);
  }, []);

  function savePercent(value: number) {
    const clamped = clampConversationPercent(value);
    setConversationPercent(clamped);
    window.localStorage.setItem(SPLIT_KEY, String(clamped));
  }

  function resizeFromPointer(event: PointerEvent<HTMLButtonElement>) {
    const bounds = rootRef.current?.getBoundingClientRect();
    if (!bounds) return;
    savePercent(((event.clientX - bounds.left) / bounds.width) * 100);
  }

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeFromPointer(event);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowLeft") savePercent(conversationPercent - 2);
    else if (event.key === "ArrowRight") savePercent(conversationPercent + 2);
    else if (event.key === "Home") savePercent(DEFAULT_CONVERSATION_PERCENT);
    else return;
    event.preventDefault();
  }

  const splitStyle = (conversationPercent === DEFAULT_CONVERSATION_PERCENT
    ? { "--studio-conversation": "2fr", "--studio-canvas": "3fr" }
    : { "--studio-conversation": `${conversationPercent}fr`, "--studio-canvas": `${100 - conversationPercent}fr` }) as CSSProperties;

  return (
    <section ref={rootRef} className={`${styles.grid} h-dvh min-h-[640px] overflow-hidden bg-[#f4f0e8] text-[#161512]`} style={splitStyle}>
      <div className={`${mobilePane === "conversation" ? "block" : "hidden"} h-full min-w-0 overflow-hidden lg:block`}>
        {conversation}
      </div>
      <button
        type="button"
        role="separator"
        aria-label="Resize conversation and canvas"
        aria-orientation="vertical"
        aria-valuemin={32}
        aria-valuemax={52}
        aria-valuenow={conversationPercent}
        className={`${styles.separator} group relative z-20 border-0 bg-[#d7d0c3] p-0 outline-none focus-visible:bg-[#3157ff]`}
        onPointerDown={onPointerDown}
        onPointerMove={(event) => event.currentTarget.hasPointerCapture(event.pointerId) && resizeFromPointer(event)}
        onKeyDown={onKeyDown}
      >
        <span className="absolute left-1/2 top-1/2 h-10 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#8d867b] transition group-hover:bg-[#3157ff]" />
      </button>
      <div className={`${mobilePane === "canvas" ? "block" : "hidden"} h-full min-w-0 overflow-hidden lg:block`}>
        {canvas}
      </div>

      <nav className="fixed inset-x-4 bottom-4 z-50 grid grid-cols-2 rounded-full border border-black/10 bg-[#161512]/95 p-1 text-sm font-bold text-white shadow-2xl backdrop-blur lg:hidden" aria-label="Studio panes">
        {(["conversation", "canvas"] as const).map((pane) => (
          <button
            key={pane}
            type="button"
            onClick={() => onMobilePaneChange(pane)}
            aria-pressed={mobilePane === pane}
            className={`rounded-full px-4 py-3 capitalize ${mobilePane === pane ? "bg-[#d9ff43] text-[#161512]" : "text-white/70"}`}
          >
            {pane === "conversation" ? "Conversation" : "Studio canvas"}
          </button>
        ))}
      </nav>
    </section>
  );
}
