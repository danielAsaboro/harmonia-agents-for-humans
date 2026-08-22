"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CalendarEvent } from "@/app/api/calendar/route";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function CalendarView() {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/calendar", { cache: "no-store" });
      if (!res.ok) throw new Error(`calendar ${res.status}`);
      setEvents((await res.json()).events);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const grid = useMemo(() => {
    const first = new Date(cursor.year, cursor.month, 1);
    const startOffset = (first.getDay() + 6) % 7; // Monday-first
    const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate();
    const cells: Array<{ date: string | null; day: number | null }> = [];
    for (let i = 0; i < startOffset; i++) cells.push({ date: null, day: null });
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ date: iso(new Date(cursor.year, cursor.month, d)), day: d });
    }
    while (cells.length % 7 !== 0) cells.push({ date: null, day: null });
    return cells;
  }, [cursor]);

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const list = map.get(e.date) ?? [];
      list.push(e);
      map.set(e.date, list);
    }
    return map;
  }, [events]);

  const todayIso = iso(new Date());
  const selectedEvents = selected ? byDate.get(selected) ?? [] : [];

  function shift(delta: number) {
    setSelected(null);
    setCursor(({ year, month }) => {
      const nextMonth = month + delta;
      return { year: year + Math.floor(nextMonth / 12), month: ((nextMonth % 12) + 12) % 12 };
    });
  }

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Content calendar</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Jobs created and posts published — real pipeline history.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => shift(-1)} aria-label="Previous month" className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">←</button>
          <span className="w-36 text-center text-sm font-medium">{MONTHS[cursor.month]} {cursor.year}</span>
          <button onClick={() => shift(1)} aria-label="Next month" className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">→</button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          Failed to load calendar: {error}
        </div>
      )}

      <div className="flex flex-col gap-3 lg:flex-row">
        <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
          <div className="grid grid-cols-7 border-b border-zinc-200 bg-zinc-50 text-center text-[11px] font-medium uppercase tracking-wide text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900">
            {WEEKDAYS.map((d) => <div key={d} className="py-2">{d}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {grid.map((cell, i) => {
              if (!cell.date) return <div key={i} className="min-h-[84px] border-b border-r border-zinc-100 dark:border-zinc-900" />;
              const dayEvents = byDate.get(cell.date) ?? [];
              const isToday = cell.date === todayIso;
              return (
                <button
                  key={i}
                  onClick={() => setSelected(cell.date)}
                  className={`min-h-[84px] border-b border-r border-zinc-100 p-1.5 text-left align-top transition-colors hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/60 ${
                    selected === cell.date ? "bg-zinc-100 dark:bg-zinc-900" : ""
                  }`}
                >
                  <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${
                    isToday ? "bg-zinc-900 font-bold text-white dark:bg-white dark:text-black" : "text-zinc-500"
                  }`}>
                    {cell.day}
                  </span>
                  <div className="mt-1 flex flex-col gap-0.5">
                    {dayEvents.slice(0, 2).map((e, j) => (
                      <span
                        key={j}
                        className={`truncate rounded px-1 py-0.5 text-[9px] leading-3 ${
                          e.kind === "published"
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                            : "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-400"
                        }`}
                      >
                        {e.kind === "published" ? "▲ " : "● "}{e.label.slice(0, 26)}
                      </span>
                    ))}
                    {dayEvents.length > 2 && (
                      <span className="text-[9px] text-zinc-400">+{dayEvents.length - 2} more</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <aside className="w-full shrink-0 rounded-xl border border-zinc-200 p-4 lg:w-72 dark:border-zinc-800">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
            {selected ?? "Select a day"}
          </h2>
          {selectedEvents.length === 0 ? (
            <p className="mt-3 text-xs text-zinc-400">Nothing recorded for this day.</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {selectedEvents.map((e, i) => (
                <li key={i} className="rounded-lg border border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
                  <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${e.kind === "published" ? "bg-emerald-500" : "bg-sky-500"}`} />
                  {e.label}
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
