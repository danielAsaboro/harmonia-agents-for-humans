"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ChatIcon, CalendarIcon, ChartIcon, SettingsIcon, SparklesIcon } from "@/components/icons";

const RAIL = [
  { href: "/dashboard", label: "Console", Icon: ChatIcon },
  { href: "/dashboard/proposals", label: "Proposals", Icon: SparklesIcon },
  { href: "/dashboard/calendar", label: "Calendar", Icon: CalendarIcon },
  { href: "/dashboard/monitoring", label: "Monitoring", Icon: ChartIcon },
  { href: "/dashboard/settings", label: "Settings", Icon: SettingsIcon },
];

function BellIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className ?? "h-5 w-5"} aria-hidden>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

/** Floating vertical nav rail — a single dynamic-island capsule, vertically centered. */
export default function NavRail() {
  const pathname = usePathname();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/notifications", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (alive && d) setUnread(d.unread ?? 0);
        })
        .catch(() => {});
    const t = setTimeout(load, 0);
    const interval = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearTimeout(t);
      clearInterval(interval);
    };
  }, [pathname]);

  return (
    <nav className="fixed left-3 top-1/2 z-40 -translate-y-1/2 sm:left-4" aria-label="Primary">
      <div className="flex flex-col items-center gap-1 rounded-full border border-zinc-200/80 bg-white/80 px-2 py-4 shadow-xl shadow-zinc-900/5 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-900/80">
        <Link
          href="/"
          title="Harmonia"
          aria-label="Harmonia home"
          className="mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-zinc-900 text-sm font-bold text-white dark:bg-white dark:text-black"
        >
          H
        </Link>
        <div className="mb-1 h-px w-6 bg-zinc-200 dark:bg-zinc-700" />
        {RAIL.map(({ href, label, Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              title={label}
              aria-label={label}
              className={`flex h-10 w-10 items-center justify-center rounded-full transition-all ${
                active
                  ? "bg-zinc-900 text-white shadow-md dark:bg-white dark:text-black"
                  : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              }`}
            >
              <Icon />
            </Link>
          );
        })}
        <Link
          href="/dashboard/notifications"
          title={`Notifications${unread ? ` (${unread} unread)` : ""}`}
          aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
          className={`relative mt-1 flex h-10 w-10 items-center justify-center rounded-full transition-all ${
            pathname === "/dashboard/notifications"
              ? "bg-zinc-900 text-white shadow-md dark:bg-white dark:text-black"
              : unread > 0
                ? "text-zinc-600 ring-2 ring-amber-400 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          }`}
        >
          <BellIcon />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Link>
      </div>
    </nav>
  );
}
