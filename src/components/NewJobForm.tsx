"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/clientApi";

export default function NewJobForm({ onCreated }: { onCreated: (jobId: string) => void }) {
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [cloudRunUrl, setCloudRunUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { youtubeUrl };
      const res = await apiFetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setGithubRepo("");
      setCloudRunUrl("");
      onCreated(data.jobId as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="grid gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900 sm:grid-cols-2"
    >
      <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400 sm:col-span-2">
        YouTube video URL
        <input
          type="url"
          required
          placeholder="https://www.youtube.com/watch?v=…"
          value={youtubeUrl}
          onChange={(e) => setYoutubeUrl(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        />
      </label>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-300"
        >
          {submitting ? "Dispatching…" : "Start content job"}
        </button>
        {error && <span className="text-sm text-red-600 dark:text-red-400">{error}</span>}
      </div>
    </form>
  );
}
