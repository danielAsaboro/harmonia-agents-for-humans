import type { AuthorityRef, PlannedItem } from "../campaigns/contracts";
import type { ContentStrategy, EditorialPlanItem } from "../types";
import { editorialPlanItemSchema } from "../contracts";
import { strategyDigest } from "../strategyApproval";

export interface EditorialRebaseReview {
  itemRef: AuthorityRef;
  previousItem: EditorialPlanItem;
  candidates: Array<{ briefId: string; item: EditorialPlanItem }>;
  defaultBriefId: string | null;
}
export interface EditorialMapping { itemRef: AuthorityRef; briefId: string }

/** Only exact channel/format matches become options. Operator review owns any ambiguity. */
export function buildEditorialRebaseReview(item: PlannedItem, strategy: ContentStrategy): EditorialRebaseReview | null {
  if (item.productionContext.mode !== "source_backed" || item.evidence.mode !== "source_backed") return null;
  const previousItem = item.productionContext.item;
  const allowed = new Set(item.evidence.sourceBinding.evidenceIds);
  const sourceItems = new Set([...item.productionContext.sourceAnalysis.moments, ...item.productionContext.sourceAnalysis.angles].map(source => source.id));
  if (!previousItem.evidenceRefs.length || previousItem.evidenceRefs.some(ref => !allowed.has(ref)) || !previousItem.evidenceRefs.some(ref => sourceItems.has(ref))) throw new Error("editorial rebase requires exact retained source evidence");
  const channel = strategy.channelRoles.find(role => role.channel === item.channel && role.operationallySupported);
  const candidates = strategy.briefs.filter(brief => channel?.formats.includes(previousItem.format) && brief.channelCandidates.includes(item.channel) && brief.formatCandidates.includes(previousItem.format)).map(brief => ({
    briefId: brief.id,
    item: editorialPlanItemSchema.parse({ ...previousItem,
      briefId: brief.id, campaignTheme: brief.title, contentPillar: strategy.pillars[0].name,
      objective: brief.objective, audienceId: brief.audienceId, funnelStage: brief.funnelStage,
      intendedConversion: brief.intendedConversion, ctaIntent: brief.ctaIntent, kpi: brief.kpi,
      priority: brief.priority, constraints: [...new Set([...brief.constraints, ...strategy.brandSafety])],
      // The retained source context remains the factual authority. A new brand
      // brief cannot add citations from a different strategy/source job.
      evidenceRefs: previousItem.evidenceRefs,
      planningRationale: `Operator-reviewed alignment to current strategy brief ${brief.id}; retained source evidence and schedule.`,
    }),
  }));
  const same = candidates.find(candidate => candidate.briefId === previousItem.briefId);
  return { itemRef: item.ref, previousItem, candidates, defaultBriefId: same?.briefId ?? (candidates.length === 1 ? candidates[0].briefId : null) };
}

export function resolveEditorialRebase(item: PlannedItem, strategy: ContentStrategy, reviews: EditorialRebaseReview[], mappings: EditorialMapping[]): EditorialPlanItem | null {
  const current = buildEditorialRebaseReview(item, strategy); if (!current) return null;
  const review = reviews.find(value => strategyDigest(value.itemRef) === strategyDigest(item.ref));
  if (!review || strategyDigest(review) !== strategyDigest(current)) throw new Error("editorial rebase mapping changed; current operator review required");
  const explicit = mappings.filter(value => strategyDigest(value.itemRef) === strategyDigest(item.ref));
  if (explicit.length > 1) throw new Error("ambiguous duplicate editorial mapping");
  const briefId = explicit[0]?.briefId ?? review.defaultBriefId;
  if (!briefId) throw new Error("exact editorial brief mapping required before rebase");
  const candidate = review.candidates.find(value => value.briefId === briefId);
  if (!candidate) throw new Error("editorial mapping is outside the reviewed current brief candidates");
  return candidate.item;
}
