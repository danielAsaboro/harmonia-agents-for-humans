import MonitoringView from "@/components/MonitoringView";

export default function MonitoringPage() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 sm:px-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Monitoring</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Live pipeline flows, stage timings, receipt outcomes, and the activity log. Refreshes every 5s.
        </p>
      </div>
      <MonitoringView />
    </div>
  );
}
