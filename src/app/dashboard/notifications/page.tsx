"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { AppNotification } from "@/lib/types";

function group(iso: string): "today" | "earlier" {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? "today" : "earlier";
}

const SEVERITY_STYLE: Record<string, { dot: string; row: string }> = {
  critical: { dot: "bg-red-500", row: "border-red-200 dark:border-red-900" },
  warning: { dot: "bg-amber-500", row: "border-amber-200 dark:border-amber-900" },
  info: { dot: "bg-sky-500", row: "border-zinc-200 dark:border-zinc-800" },
};

export default function NotificationsPage() {
  const [items, setItems] = useState<AppNotification[] | null>(null);

  const load = useCallback(() => {
    return fetch("/api/notifications", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setItems(d.notifications))
      .catch(() => setItems([]));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  async function open(n: AppNotification) {
    if (!n.id || n.readAt) {
      if (n.href) window.location.assign(n.href);
      return;
    }
    await fetch("/api/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "read", id: n.id }),
    });
    if (n.href) window.location.assign(n.href);
    else void load();
  }

  async function readAll() {
    await fetch("/api/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "read-all" }),
    });
    void load();
  }

  const today = (items ?? []).filter((n) => group(n.createdAt) === "today");
  const earlier = (items ?? []).filter((n) => group(n.createdAt) !== "today");

  function renderList(list: AppNotification[], label: string) {
    if (list.length === 0) return null;
    return (
      <div className="flex flex-col gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{label}</h2>
        {list.map((n, i) => (
          <button
            key={n.id ?? i}
            onClick={() => void open(n)}
            className={`flex items-start gap-3 rounded-xl border bg-white px-4 py-3 text-left transition-colors hover:bg-zinc-50 dark:bg-zinc-950 dark:hover:bg-zinc-900 ${
              SEVERITY_STYLE[n.severity]?.row ?? ""
            }`}
          >
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERITY_STYLE[n.severity]?.dot ?? "bg-sky-500"} ${n.readAt ? "opacity-30" : ""}`} />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className={`text-sm font-medium ${n.readAt ? "text-zinc-400" : ""}`}>{n.title}</span>
                <span className="text-[10px] uppercase tracking-wide text-zinc-400">{n.kind.replace(/_/g, " ")}</span>
              </span>
              <span className="mt-0.5 block text-xs leading-5 text-zinc-600 dark:text-zinc-400">{n.body}</span>
              <span className="mt-1 block text-[10px] text-zinc-400">
                {new Date(n.createdAt).toLocaleString()}
                {n.href && !n.readAt && <span className="ml-2 text-blue-600 underline dark:text-blue-400">view →</span>}
              </span>
            </span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Notifications</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Approvals, failures, and everything needing your attention.</p>
        </div>
        <button
          onClick={() => void readAll()}
          disabled={!items?.some((n) => !n.readAt)}
          className="rounded-full border border-zinc-300 px-4 py-1.5 text-xs font-medium hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Mark all read
        </button>
      </div>

      {items === null ? (
        <p className="py-10 text-center text-xs text-zinc-400">Loading…</p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 p-12 text-center text-sm text-zinc-400 dark:border-zinc-700">
          Nothing needs your attention right now.
        </div>
      ) : (
        <>
          {renderList(today, "Today")}
          {renderList(earlier, "Earlier")}
        </>
      )}

      <p className="text-[11px] text-zinc-400">
        Tip: approval notifications deep-link into the pipeline — job rows open in the{" "}
        <Link href="/dashboard" className="underline">console</Link>, calendar items open on the{" "}
        <Link href="/dashboard/calendar" className="underline">calendar</Link>.
      </p>
    </div>
  );
}
