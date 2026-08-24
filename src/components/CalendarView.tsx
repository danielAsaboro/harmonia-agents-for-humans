"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { CalendarEvent, CalendarItem } from "@/app/api/calendar/route";
import type { ContentItem } from "@/lib/types";
import ItemDrawer from "@/components/calendar/ItemDrawer";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const STATUS_DOT: Record<string, string> = {
  draft: "bg-zinc-400",
  scheduled: "bg-sky-500",
  awaiting_final_review: "bg-amber-500",
  publishing: "bg-blue-500",
  published: "bg-emerald-500",
  failed: "bg-red-500",
  cancelled: "bg-zinc-300",
};

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function CalendarView() {
  const router = useRouter();
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [view, setView] = useState<"month" | "agenda">("month");
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [items, setItems] = useState<CalendarItem[]>([]);
  const [jobTitles, setJobTitles] = useState<Record<string, string>>({});
  const [goals, setGoals] = useState<{ weeklyPostTarget?: number } | null>(null);
  const [selectedItem, setSelectedItem] = useState<ContentItem | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [platformFilter, setPlatformFilter] = useState<string>("");
  const [googleCalendar, setGoogleCalendar] = useState<{ connected: boolean; calendarTitle?: string } | null>(null);

  const load = useCallback(async () => {
    const [cal, goalsRes, googleRes] = await Promise.all([
      fetch("/api/calendar", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/settings/goals", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      fetch("/api/calendar/google", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    ]);
    setEvents(cal.events ?? []);
    setItems(cal.items ?? []);
    setJobTitles(cal.jobTitles ?? {});
    if (goalsRes?.goals) setGoals(goalsRes.goals);
    if (googleRes) setGoogleCalendar(googleRes);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const jobCreatedDates = useMemo(() => new Set(events.map((e) => e.date)), [events]);

  const filteredItems = useMemo(
    () =>
      items.filter(
        (i) =>
          (!statusFilter || i.status === statusFilter) &&
          (!platformFilter || i.platforms.includes(platformFilter)),
      ),
    [items, statusFilter, platformFilter],
  );

  // date -> items on that day (scheduled/published/review by their anchor date)
  const itemsByDate = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();
    for (const item of filteredItems) {
      const anchor =
        item.status === "published"
          ? (item.publishedAt ?? item.scheduledFor)
          : (item.scheduledFor ?? item.createdAt);
      if (!anchor) continue;
      const key = anchor.slice(0, 10);
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return map;
  }, [filteredItems]);

  const grid = useMemo(() => {
    const first = new Date(cursor.year, cursor.month, 1);
    const startOffset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate();
    const cells: Array<{ date: string | null; day: number | null }> = [];
    for (let i = 0; i < startOffset; i++) cells.push({ date: null, day: null });
    for (let d = 1; d <= daysInMonth; d++) cells.push({ date: iso(new Date(cursor.year, cursor.month, d)), day: d });
    while (cells.length % 7 !== 0) cells.push({ date: null, day: null });
    return cells;
  }, [cursor]);

  // cadence ghosts: weeks where scheduled+published count is under the weekly target
  const ghostSlots = useMemo(() => {
    const target = goals?.weeklyPostTarget ?? 0;
    if (!target || view !== "month") return new Map<string, number>();
    const counts = new Map<string, number>();
    for (const [, list] of itemsByDate) {
      for (const it of list) {
        if (!["scheduled", "awaiting_final_review", "published", "publishing"].includes(it.status)) continue;
        const anchor = it.status === "published" ? it.publishedAt ?? it.createdAt : it.scheduledFor ?? it.createdAt;
        if (!anchor) continue;
        const d = new Date(anchor);
        const monday = new Date(d);
        monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
        const key = iso(monday);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const ghosts = new Map<string, number>();
    for (const cell of grid) {
      if (!cell.date) continue;
      const d = new Date(`${cell.date}T12:00:00`);
      const monday = new Date(d);
      monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const key = iso(monday);
      const have = counts.get(key) ?? 0;
      const missing = target - have;
      if (missing > 0 && d.getDay() === 0) {
        // surface the gap once per week, on Sunday
        ghosts.set(cell.date, missing);
      }
    }
    return ghosts;
  }, [goals, itemsByDate, grid, view]);

  function shift(delta: number) {
    setSelectedItem(null);
    setCursor(({ year, month }) => {
      const nextMonth = month + delta;
      return { year: year + Math.floor(nextMonth / 12), month: ((nextMonth % 12) + 12) % 12 };
    });
  }

  function openInChat(item: ContentItem) {
    setSelectedItem(null);
    router.push(`/dashboard?job=${encodeURIComponent(item.jobId)}&item=${encodeURIComponent(item.id)}`);
  }

  const agendaItems = useMemo(
    () =>
      [...filteredItems]
        .filter((i) => ["scheduled", "awaiting_final_review"].includes(i.status))
        .sort((a, b) => Date.parse(a.scheduledFor ?? "") - Date.parse(b.scheduledFor ?? "")),
    [filteredItems],
  );

  const todayIso = iso(new Date());

  return (
    <div className="flex flex-col gap-4">
      <div className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-4 py-3 text-xs ${googleCalendar?.connected ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300" : "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300"}`}>
        <span>
          {googleCalendar?.connected
            ? `Google Calendar connected${googleCalendar.calendarTitle ? ` · ${googleCalendar.calendarTitle}` : ""}. Open a scheduled item to approve its sync.`
            : "Connect Google Calendar to put Harmonia’s content schedule on your calendar."}
        </span>
        {!googleCalendar?.connected && <a href="/dashboard/settings" className="font-semibold underline">Connect Google Calendar</a>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {view === "month" ? (
          <div className="flex items-center gap-2">
            <button onClick={() => shift(-1)} aria-label="Previous month" className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">←</button>
            <span className="w-36 text-center text-sm font-medium">{MONTHS[cursor.month]} {cursor.year}</span>
            <button onClick={() => shift(1)} aria-label="Next month" className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">→</button>
          </div>
        ) : (
          <h2 className="text-sm font-semibold">Upcoming</h2>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="">all statuses</option>
            {["draft", "scheduled", "awaiting_final_review", "published", "failed", "cancelled"].map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
            ))}
          </select>
          <select
            value={platformFilter}
            onChange={(e) => setPlatformFilter(e.target.value)}
            className="rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs capitalize dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="">all channels</option>
            <option value="x">x</option>
          </select>
          <div className="flex gap-1 rounded-full border border-zinc-200 p-1 text-xs dark:border-zinc-800">
            {(["month", "agenda"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded-full px-3 py-1 font-medium capitalize ${
                  view === v ? "bg-zinc-900 text-white dark:bg-white dark:text-black" : "text-zinc-500 dark:text-zinc-400"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      {view === "month" ? (
        <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
          <div className="grid grid-cols-7 border-b border-zinc-200 bg-zinc-50 text-center text-[11px] font-medium uppercase tracking-wide text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900">
            {WEEKDAYS.map((d) => <div key={d} className="py-2">{d}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {grid.map((cell, i) => {
              if (!cell.date) return <div key={i} className="min-h-[92px] border-b border-r border-zinc-100 dark:border-zinc-900" />;
              const dayItems = itemsByDate.get(cell.date) ?? [];
              const ghost = ghostSlots.get(cell.date);
              const isToday = cell.date === todayIso;
              return (
                <div key={i} className={`min-h-[92px] border-b border-r border-zinc-100 p-1.5 align-top dark:border-zinc-900 ${isToday ? "bg-amber-50/40 dark:bg-amber-950/10" : ""}`}>
                  <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${
                    isToday ? "bg-zinc-900 font-bold text-white dark:bg-white dark:text-black" : "text-zinc-500"
                  }`}>
                    {cell.day}
                  </span>
                  <div className="mt-1 flex flex-col gap-0.5">
                    {dayItems.slice(0, 2).map((it) => (
                      <button
                        key={it.id}
                        onClick={() => setSelectedItem(it)}
                        className="flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[9px] leading-3 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        title={`${it.text}\n[${it.status}] ${it.platforms.join(", ")}`}
                      >
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[it.status] ?? "bg-zinc-400"}`} />
                        <span className="truncate text-zinc-600 dark:text-zinc-300">{it.text.slice(0, 30)}</span>
                      </button>
                    ))}
                    {dayItems.length > 2 && (
                      <span className="pl-2.5 text-[9px] text-zinc-400">+{dayItems.length - 2} more</span>
                    )}
                    {jobCreatedDates.has(cell.date) && dayItems.length === 0 && (
                      <span className="truncate px-1 text-[9px] text-zinc-400" title="A content job was created this day">✦ job created</span>
                    )}
                    {ghost && dayItems.length === 0 && (
                      <span className="truncate rounded border border-dashed border-zinc-300 px-1 py-0.5 text-[9px] text-zinc-400 dark:border-zinc-700" title={`Weekly goal: ${goals?.weeklyPostTarget} posts — this week looks thin`}>
                        ◻ {ghost} open slot{ghost > 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800">
          {agendaItems.length === 0 ? (
            <p className="p-8 text-center text-sm text-zinc-400">Nothing scheduled ahead — schedule a draft from the month view.</p>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {agendaItems.map((item) => (
                <li key={item.id}>
                  <button onClick={() => setSelectedItem(item)} className="w-full px-4 py-3 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/60">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-medium text-zinc-500">
                        {item.scheduledFor ? new Date(item.scheduledFor).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                        item.status === "awaiting_final_review" ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400" : "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-400"
                      }`}>
                        {item.publishMode === "auto" ? "auto" : "review"}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm leading-6">{item.text}</p>
                    <p className="mt-0.5 text-[11px] capitalize text-zinc-400">{item.platforms.join(", ")} · {item.status.replace(/_/g, " ")}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-zinc-400">
        {Object.entries(STATUS_DOT).map(([status, dot]) => (
          <span key={status} className="flex items-center gap-1">
            <span className={`h-2 w-2 rounded-full ${dot}`} /> {status.replace(/_/g, " ")}
          </span>
        ))}
        <span className="flex items-center gap-1"><span className="border border-dashed border-zinc-400 px-1">◻</span> cadence gap vs weekly goal</span>
      </div>

      {selectedItem && (
        <ItemDrawer
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
          onSaved={() => void load()}
          onOpenInChat={openInChat}
        />
      )}
    </div>
  );
}
