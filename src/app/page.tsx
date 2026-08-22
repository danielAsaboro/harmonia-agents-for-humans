import Link from "next/link";

const LOOP = [
  { phase: "Research", desc: "Trends, niche conversations, competitor moves, and your own back catalog feed the idea engine.", status: "in" },
  { phase: "Ideate", desc: "Angles, hooks, meme formats, thread outlines — ranked and grounded in your positioning.", status: "live" },
  { phase: "Create", desc: "Written posts, images, memes, video clips cut and stitched from long-form or generated fresh.", status: "part" },
  { phase: "Edit", desc: "Platform-native crops, captions, thumbnails; every asset versioned and previewable.", status: "planned" },
  { phase: "Publish", desc: "Official platform APIs behind a human approval gate. Idempotent, receipted, never accidental.", status: "part" },
  { phase: "Learn", desc: "Reactions and performance metrics flow back into research, so each cycle posts sharper than the last.", status: "planned" },
];

const STATUS_STYLE: Record<string, string> = {
  live: "border-emerald-400 text-emerald-600 dark:text-emerald-400",
  in: "border-sky-400 text-sky-600 dark:text-sky-400",
  part: "border-amber-400 text-amber-600 dark:text-amber-400",
  planned: "border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400",
};

const STATUS_LABEL: Record<string, string> = {
  live: "live now",
  in: "in build",
  part: "partial",
  planned: "on the map",
};

const OUTPUTS = [
  { title: "Written", desc: "X threads, LinkedIn posts, captions — voice-matched, policy-checked." },
  { title: "Images & memes", desc: "Generated or remixed from your footage, sized per platform." },
  { title: "Video clips", desc: "Moments auto-found, cut, captioned, and stitched into shorts." },
];

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5 sm:px-8">
        <span className="text-lg font-semibold tracking-tight">Harmonia</span>
        <Link
          href="/dashboard"
          className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-black dark:hover:bg-zinc-300"
        >
          Open dashboard
        </Link>
      </header>

      <main className="flex flex-1 flex-col">
        <section className="mx-auto flex w-full max-w-6xl flex-col items-start gap-6 px-4 pt-16 pb-20 sm:px-8">
          <span className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            The social media content engine for startups
          </span>
          <h1 className="max-w-3xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            From raw material to published post —
            <span className="text-zinc-400"> researched, created, edited, approved, learned from.</span>
          </h1>
          <p className="max-w-2xl text-base leading-7 text-zinc-600 dark:text-zinc-400">
            Harmonia runs the whole content gamut as one asynchronous workflow: it researches what&apos;s
            worth saying, ideates angles, creates written posts, images, memes, and video clips,
            edits them platform-native, then stops at a human approval gate before publishing through
            official APIs — and feeds every reaction back into the next cycle.
          </p>
          <div className="flex gap-3">
            <Link
              href="/dashboard"
              className="rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-black dark:hover:bg-zinc-300"
            >
              Start a job
            </Link>
            <Link
              href="/dashboard/monitoring"
              className="rounded-full border border-zinc-300 px-5 py-2.5 text-sm font-medium text-zinc-700 transition-colors hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-300"
            >
              See it run →
            </Link>
          </div>
        </section>

        <section className="border-y border-zinc-200 bg-zinc-50 py-14 dark:border-zinc-800 dark:bg-zinc-900/40">
          <div className="mx-auto w-full max-w-6xl px-4 sm:px-8">
            <div className="mb-8 flex items-baseline justify-between gap-4">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">The loop</h2>
              <p className="text-[11px] text-zinc-400">Every phase is a durable pipeline stage with receipts.</p>
            </div>
            <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {LOOP.map((step, i) => (
                <li key={step.phase} className="flex flex-col rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-900 text-[11px] font-bold text-white dark:bg-white dark:text-black">
                        {i + 1}
                      </span>
                      <span className="font-medium">{step.phase}</span>
                    </div>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_STYLE[step.status]}`}>
                      {STATUS_LABEL[step.status]}
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{step.desc}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-8">
          <h2 className="mb-8 text-sm font-semibold uppercase tracking-wider text-zinc-500">What it makes</h2>
          <div className="grid gap-8 sm:grid-cols-3">
            {OUTPUTS.map((o) => (
              <div key={o.title}>
                <h3 className="font-medium">{o.title}</h3>
                <p className="mt-1.5 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{o.desc}</p>
              </div>
            ))}
          </div>
          <div className="mt-12 grid gap-8 sm:grid-cols-2">
            <div>
              <h3 className="font-medium">Approval is not optional</h3>
              <p className="mt-1.5 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                The agent proposes; you dispose. Publishing exists only as discrete approved actions —
                decided from the dashboard, the chat drawer, or Telegram. Every decision is recorded.
              </p>
            </div>
            <div>
              <h3 className="font-medium">Receipts, not vibes</h3>
              <p className="mt-1.5 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                Idempotency keys prevent duplicate posts under redelivery. Verification re-fetches
                published state through independent API reads before anything is called done.
                Failures stay visible instead of pretending to succeed.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-zinc-200 py-6 text-center text-xs text-zinc-400 dark:border-zinc-800">
        Built on Gemini · Google ADK · Cloud Run · Firestore · Pub/Sub
      </footer>
    </div>
  );
}
