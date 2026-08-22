"use client";

import { useEffect, useState } from "react";
import { apiFetch, getOperatorToken, setOperatorToken } from "@/lib/clientApi";

interface HealthInfo {
  ok: boolean;
  service: string;
  project: string;
  model?: string;
  stages?: string[];
}

interface Goals {
  weeklyPostTarget?: number;
  audience?: string;
  voice?: string;
  topics: string[];
}

const EMPTY_GOALS: Goals = { topics: [] };

function GoalsSection() {
  const [goals, setGoals] = useState<Goals>(EMPTY_GOALS);
  const [topicDraft, setTopicDraft] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/settings/goals")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setGoals({ ...EMPTY_GOALS, ...d.goals }))
      .catch(() => setLoadError("Could not load goals."));
  }, []);

  async function save(next: Goals) {
    setStatus("saving");
    try {
      const res = await apiFetch("/api/settings/goals", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error();
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 1500);
    } catch {
      setStatus("error");
      setTimeout(() => setStatus("idle"), 2500);
    }
  }

  function addTopic() {
    const t = topicDraft.trim();
    if (!t || goals.topics.includes(t) || goals.topics.length >= 10) return;
    const next = { ...goals, topics: [...goals.topics, t] };
    setGoals(next);
    setTopicDraft("");
    void save(next);
  }

  return (
    <section className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
      <h2 className="text-sm font-semibold">Content goals</h2>
      <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
        Strategy the agent optimizes toward. Goals are injected into every research and
        ideation prompt, alongside what performed well in past posts.
        {status === "saving" && " Saving…"}
        {status === "saved" && " Saved ✓"}
        {status === "error" && " Save failed — check operator token."}
        {loadError && ` ${loadError}`}
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Weekly post target
          <input
            type="number"
            min={1}
            max={50}
            value={goals.weeklyPostTarget ?? ""}
            onChange={(e) => {
              const v = e.target.value ? Number(e.target.value) : undefined;
              setGoals((g) => ({ ...g, weeklyPostTarget: v }));
            }}
            onBlur={() => void save(goals)}
            placeholder="e.g. 5"
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Target audience
          <input
            value={goals.audience ?? ""}
            onChange={(e) => setGoals((g) => ({ ...g, audience: e.target.value }))}
            onBlur={() => void save(goals)}
            placeholder="e.g. seed-stage technical founders"
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400 sm:col-span-2">
          Brand voice
          <input
            value={goals.voice ?? ""}
            onChange={(e) => setGoals((g) => ({ ...g, voice: e.target.value }))}
            onBlur={() => void save(goals)}
            placeholder="e.g. direct, technical, allergic to hype"
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </label>
      </div>

      <div className="mt-4">
        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Priority topics</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {goals.topics.map((t) => (
            <button
              key={t}
              onClick={() => {
                const next = { ...goals, topics: goals.topics.filter((x) => x !== t) };
                setGoals(next);
                void save(next);
              }}
              title="Remove topic"
              className="rounded-full bg-zinc-100 px-3 py-1 text-xs text-zinc-600 hover:bg-red-100 hover:text-red-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-red-950"
            >
              {t} ✕
            </button>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <input
            value={topicDraft}
            onChange={(e) => setTopicDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addTopic()}
            placeholder="add a topic and press Enter"
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
          <button onClick={addTopic} className="shrink-0 rounded-md bg-zinc-900 px-4 py-2 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-black dark:hover:bg-zinc-300">
            Add
          </button>
        </div>
      </div>
    </section>
  );
}

export default function SettingsView() {
  const [tokenInput, setTokenInput] = useState("");
  const [saved, setSaved] = useState(false);
  const [health, setHealth] = useState<HealthInfo | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setTokenInput(getOperatorToken());
      fetch("/api/health", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then(setHealth)
        .catch(() => setHealth(null));
    }, 0);
    return () => clearTimeout(t);
  }, []);

  function save() {
    setOperatorToken(tokenInput.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <GoalsSection />

      <section className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
        <h2 className="text-sm font-semibold">Operator token</h2>
        <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
          Required for job creation, approvals, retries, and mutating chat commands when
          OPERATOR_TOKEN is configured on the server (always in cloud). Stored only in this
          browser&apos;s localStorage and sent as the x-operator-token header.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="paste operator token"
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-xs outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
          <button
            onClick={save}
            className="shrink-0 rounded-md bg-zinc-900 px-4 py-2 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-black dark:hover:bg-zinc-300"
          >
            {saved ? "Saved ✓" : "Save"}
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
        <h2 className="text-sm font-semibold">Service</h2>
        {health ? (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-xs">
            <dt className="text-zinc-400">Web service</dt>
            <dd className="font-mono">{health.service}</dd>
            <dt className="text-zinc-400">GCP project</dt>
            <dd className="font-mono">{health.project}</dd>
            {health.model && (
              <>
                <dt className="text-zinc-400">Model</dt>
                <dd className="font-mono">{health.model}</dd>
              </>
            )}
          </dl>
        ) : (
          <p className="mt-2 text-xs text-zinc-400">Health endpoint unreachable.</p>
        )}
      </section>

      <section className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
        <h2 className="text-sm font-semibold">Integrations</h2>
        <ul className="mt-3 flex flex-col gap-2 text-xs leading-5 text-zinc-600 dark:text-zinc-400">
          <li>
            <strong className="text-zinc-800 dark:text-zinc-200">X publishing</strong> — enabled
            when X_BEARER_TOKEN is configured server-side; posts go through the official X API v2.
          </li>
          <li>
            <strong className="text-zinc-800 dark:text-zinc-200">Telegram</strong> — enabled when
            TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_CHAT_ID are set on the worker; scoped to one
            allow-listed chat, approvals require inline-button taps.
          </li>
          <li>
            <strong className="text-zinc-800 dark:text-zinc-200">Gemini</strong> — required for
            transcription, analysis, drafting, and chat intent parsing (GEMINI_API_KEY).
          </li>
        </ul>
        <p className="mt-3 text-[11px] text-zinc-400">
          Integration credentials are server-side secrets; this page only documents their
          expected configuration and never displays them.
        </p>
      </section>
    </div>
  );
}
