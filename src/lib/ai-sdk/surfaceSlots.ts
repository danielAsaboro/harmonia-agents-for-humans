import { parseHarmoniaSurfacePart, type HarmoniaSurfacePart } from "./contracts";
import type { SurfaceSlot } from "./presentationContracts";

export function latestSurfaceParts(parts: unknown[], slot: SurfaceSlot): HarmoniaSurfacePart[] {
  const latest = new Map<string, HarmoniaSurfacePart>();
  for (const input of parts) {
    const part = parseHarmoniaSurfacePart(input);
    const existing = latest.get(part.data.slot);
    if (!existing || part.data.revision > existing.data.revision) latest.set(part.data.slot, part);
  }
  const selected = latest.get(slot);
  return selected ? [selected] : [];
}
