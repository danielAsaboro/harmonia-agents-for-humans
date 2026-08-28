import type { ReactNode } from "react";

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

export function StudioFailure({ message, permanent, onRetry }: { message: string; permanent?: boolean; onRetry?: () => void }) {
  return (
    <section role="alert" className="border-2 border-[#ff5c35] bg-[#fff1eb] p-4">
      <p className="text-xs font-black uppercase tracking-[0.18em] text-[#9f2c11]">{permanent ? "Protocol failure" : "Execution interrupted"}</p>
      <p className="mt-2 text-sm text-[#4b1a0e]">{message}</p>
      {onRetry ? <button type="button" onClick={onRetry} className="mt-3 bg-[#161512] px-4 py-2 text-sm font-bold text-white">{permanent ? "Retry after fix" : "Retry"}</button> : null}
    </section>
  );
}
