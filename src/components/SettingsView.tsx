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

interface ConnectionInfo {
  id: string;
  label: string;
  capabilities: string[];
  note: string;
  docsUrl: string;
  status: "connected" | "connectable" | "credentials_needed";
  missingActive: string[];
  missingRequired: string[];
}

const CAP_LABELS: Record<string, string> = {
  publish: "publish",
  verify: "verify",
  metrics: "metrics",
};

function ConnectionsSection() {
  const [connections, setConnections] = useState<ConnectionInfo[] | null>(null);

  useEffect(() => {
    fetch("/api/settings/connections", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setConnections(d.connections))
      .catch(() => setConnections([]));
  }, []);

  return (
    <section className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
      <h2 className="text-sm font-semibold">Connected accounts</h2>
      <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
        Official platform APIs only — no scraping, no automation evasion. Status reflects the
        actual server configuration; nothing shows as connected until its credentials exist
        server-side. Publishing always passes the human approval gate.
      </p>
      {!connections ? (
        <p className="mt-3 text-xs text-zinc-400">Loading…</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {connections.map((c) => (
            <li key={c.id} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className={`flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold uppercase ${
                    c.status === "connected"
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                      : c.status === "connectable"
                        ? "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-400"
                        : "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400"
                  }`}>
                    {c.label.slice(0, 2)}
                  </span>
                  <span className="text-sm font-medium">{c.label}</span>
                </div>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                  c.status === "connected"
                    ? "border-emerald-400 text-emerald-600 dark:text-emerald-400"
                    : c.status === "connectable"
                      ? "border-sky-400 text-sky-600 dark:text-sky-400"
                      : "border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
                }`}>
                  {c.status === "connected" ? "connected" : c.status === "connectable" ? "ready to connect" : "credentials needed"}
                </span>
              </div>
              <p className="mt-1.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{c.note}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
                <span className="text-zinc-400">
                  capabilities: {c.capabilities.map((k) => CAP_LABELS[k] ?? k).join(", ") || "—"}
                </span>
                {c.missingActive.length > 0 && (
                  <span className="font-mono text-amber-600 dark:text-amber-400">
                    needs token: {c.missingActive.join(", ")}
                  </span>
                )}
                {c.missingRequired.length > 0 && (
                  <span className="font-mono text-zinc-400">
                    app config missing: {c.missingRequired.join(", ")}
                  </span>
                )}
                <a href={c.docsUrl} target="_blank" rel="noopener noreferrer" className="ml-auto underline text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
                  developer docs ↗
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
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
      <ConnectionsSection />

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
