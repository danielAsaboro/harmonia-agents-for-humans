import type { AnalysisResearchRequest, AnalysisSearchEvidence } from "./types";

export function validateAnalysisSearchGrounding(
  request: AnalysisResearchRequest | null,
  evidence: AnalysisSearchEvidence[],
  metadata: Record<string, unknown> | null,
): void {
  if (!request) {
    if (evidence.length || metadata) throw new Error("analysis search requires an exact research request");
    return;
  }
  if (!evidence.length || !metadata) throw new Error("requested analysis research requires grounded evidence");
  const chunks = metadata.groundingChunks;
  const supports = metadata.groundingSupports;
  if (!Array.isArray(chunks) || !Array.isArray(supports)) throw new Error("native analysis grounding metadata incomplete");
  if (request.mode === "public_web") {
    if (!Array.isArray(metadata.webSearchQueries) || !metadata.webSearchQueries.length || !metadata.searchEntryPoint) {
      throw new Error("public analysis grounding metadata incomplete");
    }
  } else if (!Array.isArray(metadata.retrievalQueries) || !metadata.retrievalQueries.length) {
    throw new Error("private analysis grounding metadata incomplete");
  }
  const expectedKind = request.mode === "public_web" ? "public_context" : "private_context";
  const contextKey = request.mode === "public_web" ? "web" : "retrievedContext";
  const seen = new Set<string>();
  for (const source of evidence) {
    if (source.evidenceKind !== expectedKind) throw new Error("analysis evidence provider mismatch");
    if (seen.has(source.evidenceId)) throw new Error("duplicate analysis search evidence");
    seen.add(source.evidenceId);
    const indices = chunks.flatMap((chunk, index) => {
      const context = (chunk as Record<string, { uri?: string; title?: string }> | undefined)?.[contextKey];
      return context?.uri === source.url && context.title === source.title ? [index] : [];
    });
    const supported = supports.some((support) => {
      const value = support as { groundingChunkIndices?: number[]; segment?: { text?: string } };
      return value.groundingChunkIndices?.some((index) => indices.includes(index))
        && value.segment?.text?.includes(source.supportedText);
    });
    if (!indices.length || !supported) throw new Error("analysis source absent from native grounding metadata");
  }
}
