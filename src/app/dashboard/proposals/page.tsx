import ProposalsView from "@/components/ProposalsView";

export default function ProposalsPage() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 sm:px-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Proactive proposals</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          The agent watches trends and your engagement on its own schedule and proposes
          topics with reasons and sources. Approving a proposal starts a standard content
          job behind the usual approval gate.
        </p>
      </div>
      <ProposalsView />
    </div>
  );
}
