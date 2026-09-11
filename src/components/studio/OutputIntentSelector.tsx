"use client";
import { OUTPUT_CAPABILITIES, outputCapabilityStatus } from "@/lib/outputCapabilities";
import type { OutputKind } from "@/lib/types";

const LABELS: Record<OutputKind, string> = {
  x_post: "X post", x_thread: "X thread", linkedin_post: "LinkedIn post", blog_article: "Article",
  newsletter: "Newsletter", caption: "Caption", carousel_spec: "Carousel", social_image: "Social image",
  quote_card: "Quote card", diagram: "Diagram", short_clip: "Short clip", reel: "Reel",
  generated_video: "Generated video", generated_music: "Generated music",
  editorial_calendar: "Editorial calendar", content_pack: "Content pack",
};
const STATE_LABEL = { export_available: "Export available", publish_when_connected: "Publish when connected", unavailable: "Unavailable" } as const;

export function outputLabel(kind: OutputKind): string {
  return LABELS[kind];
}

export function OutputIntentSelector({ selected, onChange, disabled }: { selected: OutputKind[]; onChange: (outputs: OutputKind[]) => void; disabled?: boolean }) {
  return <div className="flex gap-1 overflow-x-auto" aria-label="Desired outputs">
    {(Object.entries(OUTPUT_CAPABILITIES) as Array<[OutputKind, (typeof OUTPUT_CAPABILITIES)[OutputKind]]>).map(([id, capability]) => {
      const active = selected.includes(id); const unavailable = capability.state === "unavailable";
      const status = outputCapabilityStatus(id);
      const providerLabel = status.providerAvailability === "not_configured" ? "Provider not configured" : STATE_LABEL[capability.state];
      const verificationLabel = status.liveVerification === "not_verified" ? "Live verification pending" : null;
      return <button key={id} type="button" disabled={disabled || unavailable} aria-pressed={active} aria-label={`${LABELS[id]} — ${STATE_LABEL[capability.state]} — ${providerLabel}${verificationLabel ? ` — ${verificationLabel}` : ""}`} onClick={() => onChange(active ? selected.filter((item) => item !== id) : [...selected, id])} className={`shrink-0 rounded-full border px-2 py-1 text-[8px] font-bold ${active ? "border-black bg-black text-white" : "border-black/15 bg-white/60 text-black/55"} disabled:cursor-not-allowed disabled:opacity-45`}>
        <span>{LABELS[id]}</span><span className="ml-1 font-normal">· {providerLabel}{verificationLabel ? ` · ${verificationLabel}` : ""}</span>
      </button>;
    })}
  </div>;
}
