"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChatIcon, CalendarIcon, ChartIcon, SettingsIcon } from "@/components/icons";

const RAIL = [
  { href: "/dashboard", label: "Console", Icon: ChatIcon },
  { href: "/dashboard/calendar", label: "Calendar", Icon: CalendarIcon },
  { href: "/dashboard/monitoring", label: "Monitoring", Icon: ChartIcon },
  { href: "/dashboard/settings", label: "Settings", Icon: SettingsIcon },
];

/** Floating vertical nav rail — a single dynamic-island capsule, vertically centered. */
export default function NavRail() {
  const pathname = usePathname();

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
      </div>
    </nav>
  );
}
