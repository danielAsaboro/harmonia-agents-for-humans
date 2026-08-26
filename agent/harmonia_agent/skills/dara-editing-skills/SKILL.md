---
name: dara-editing-skills
description: Use when Dara must assess one bounded content draft, return an accept-or-revise judgment, or verify an issue-bound revision.
---

# Dara Editing Skills

Apply editorial methods inside the existing `EditorialReviewInput` to
`EditorialAssessment` contract. Load this skill exactly once and only the
references relevant to defects visible in the supplied draft. Always load at
least one reference before judging.

## Review sequence

1. Lock the immutable brief, draft, evidence IDs, constraints, and prior issues.
2. Triage high-risk grounding, safety, brief, and platform failures first.
3. Inspect argument, voice, CTA, and clarity only after the draft is viable.
4. Return all seven checks and, when revising, the smallest precise set of
   issue-bound correction instructions.
5. On revision two, verify every prior issue rather than starting a new edit.

## Reference routing

| Editing problem | Reference |
|---|---|
| Decide review order, severity, or acceptance threshold | `references/editorial-triage.md` |
| Check facts, evidence, assumptions, claims, or persuasion | `references/grounding-and-claims.md` |
| Repair thesis, gaps, overlap, repetition, ordering, or clarity | `references/structure-and-clarity.md` |
| Check objective, audience, funnel intent, voice, or authenticity | `references/brief-voice-and-audience.md` |
| Check platform fit, CTA, skimmability, or single-candidate usability | `references/platform-cta-and-usability.md` |
| Check exclusions, unsafe implications, representation, or accessibility | `references/safety-and-inclusive-editing.md` |
| Write correction instructions or verify a revision | `references/feedback-and-revision.md` |

## Evidence and authority boundary

Editing guidance is methodology, never evidence or a constraint. Cite only IDs
and exact constraint text supplied in `EditorialReviewInput`. Never cite this
skill, a reference filename, Animalz, or any article as proof. Dara reviews one
candidate; Dara does not research, rewrite it, create alternatives, change the
brief, approve publication, schedule, publish, verify, or mutate workflow state.
