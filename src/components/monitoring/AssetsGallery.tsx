"use client";

import { useEffect, useState } from "react";

interface AssetInfo {
  actionId: string;
  jobId: string;
  mime: string;
  digest: string;
  sizeBytes: number;
  createdAt: string;
}

export default function AssetsGallery() {
  const [assets, setAssets] = useState<AssetInfo[] | null>(null);
  const [mimeFilter, setMimeFilter] = useState("");

  useEffect(() => {
    const t = setTimeout(() => {
      fetch("/api/assets", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => setAssets(d.assets))
        .catch(() => setAssets([]));
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const rows = (assets ?? []).filter((a) => !mimeFilter || a.mime === mimeFilter);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setMimeFilter("")}
          className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
            !mimeFilter ? "bg-zinc-900 text-white dark:bg-white dark:text-black" : "border border-zinc-300 text-zinc-500 dark:border-zinc-700"
          }`}
        >
          all
        </button>
        {["video/mp4", "image/png"].map((m) => (
          <button
            key={m}
            onClick={() => setMimeFilter(mimeFilter === m ? "" : m)}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
              mimeFilter === m ? "bg-zinc-900 text-white dark:bg-white dark:text-black" : "border border-zinc-300 text-zinc-500 hover:border-zinc-400 dark:border-zinc-700"
            }`}
          >
            {m === "video/mp4" ? "clips & reels" : "images"}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-zinc-400">{rows.length} asset(s)</span>
      </div>

      {assets === null ? (
        <p className="p-6 text-center text-xs text-zinc-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-400 dark:border-zinc-700">
          No assets yet — approve image/clip actions on a job and they appear here.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((a) => (
            <figure key={`${a.jobId}_${a.actionId}`} className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
              {a.mime.startsWith("video/") ? (
                <video src={`/api/jobs/${a.jobId}/assets/${a.actionId}`} controls className="aspect-[9/16] w-full object-cover sm:aspect-video" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/jobs/${a.jobId}/assets/${a.actionId}`} alt={`asset ${a.actionId}`} className="aspect-square w-full object-cover" />
              )}
              <figcaption className="space-y-0.5 px-3 py-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono">{a.mime}</span>
                  <span>{(a.sizeBytes / 1024).toFixed(0)} KB</span>
                </div>
                <div>job <span className="font-mono">{a.jobId.slice(0, 14)}</span></div>
                <div className="truncate font-mono" title={a.digest}>sha256 {a.digest.slice(0, 14)}…</div>
                <div>{new Date(a.createdAt).toLocaleString()}</div>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}
