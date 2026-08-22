import SettingsView from "@/components/SettingsView";

export default function SettingsPage() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 sm:px-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Operator identity and service configuration.
        </p>
      </div>
      <SettingsView />
    </div>
  );
}
