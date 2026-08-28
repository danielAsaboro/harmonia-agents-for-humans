import type { JobDesiredState } from "./jobShell";

export type WorkAdmission =
  | { outcome: "execute" }
  | { outcome: "paused" }
  | { outcome: "cancelled" };

export function decideWorkAdmission(desiredState: JobDesiredState): WorkAdmission {
  if (desiredState === "pause_requested") return { outcome: "paused" };
  if (desiredState === "cancel_requested") return { outcome: "cancelled" };
  return { outcome: "execute" };
}
