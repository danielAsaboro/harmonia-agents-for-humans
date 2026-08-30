"use client";

import { useState, type ReactNode } from "react";

export function StudioEmpty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid min-h-64 place-items-center border border-dashed border-black/20 bg-white/40 p-8 text-center">
      <div className="max-w-sm"><p className="font-serif text-2xl">{title}</p><div className="mt-2 text-sm text-black/55">{children}</div></div>
    </section>
  );
}

export function StudioLoading({ label = "Loading the working set" }: { label?: string }) {
  return <div role="status" className="animate-pulse border border-black/10 bg-white/55 p-5 text-sm font-semibold text-black/55">{label}…</div>;
}

export function StudioFailure({ message, permanent, onRetry, onRetryAfterFix, details }: { message: string; permanent?: boolean; onRetry?: () => void | Promise<void>; onRetryAfterFix?: () => void | Promise<void>; details?: Record<string, string | number | boolean> }) {
  const historicalRecord = message.includes("erased by retention");
  const contractDetails = details ? [details.endpoint, details.path, details.issueCode, details.maximum !== undefined ? `maximum ${details.maximum}` : null].filter(Boolean).join(" · ") : "";
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  async function retry(action: () => void | Promise<void>) {
    setRetrying(true);
    setRetryError(null);
    try {
      await action();
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : String(error));
    } finally {
      setRetrying(false);
    }
  }
  return (
    <section role="alert" className="border-2 border-[#ff5c35] bg-[#fff1eb] p-4">
      <p className="text-xs font-black uppercase tracking-[0.18em] text-[#9f2c11]">{historicalRecord ? "Historical record" : permanent ? "Protocol failure" : "Execution interrupted"}</p>
      <p className="mt-2 text-sm text-[#4b1a0e]">{message}</p>
      {contractDetails ? <p className="mt-2 font-mono text-[10px] text-[#7e2b16]">{contractDetails}</p> : null}
      {permanent && !historicalRecord ? <p className="mt-3 text-xs font-semibold text-[#7e2b16]">A code or contract correction must be deployed before this job can be resumed.</p> : null}
      {onRetry && !permanent ? <button type="button" disabled={retrying} onClick={() => void retry(onRetry)} className="mt-3 bg-[#161512] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{retrying ? "Retrying…" : "Retry"}</button> : null}
      {onRetryAfterFix && permanent && !historicalRecord ? <button type="button" disabled={retrying} onClick={() => void retry(onRetryAfterFix)} className="mt-3 bg-[#161512] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{retrying ? "Resuming…" : "Resume corrected job"}</button> : null}
      {retryError ? <p className="mt-2 text-xs font-semibold text-[#9f2c11]">{retryError}</p> : null}
    </section>
  );
}
