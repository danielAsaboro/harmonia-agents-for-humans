---
name: posting-schedule
description: >-
  Derive evidence-based posting windows from this workspace's own published
  history. Use when the operator asks when to post or wants a posting rhythm
  grounded in their data.
---

# Posting Schedule

Derive windows from the workspace's measured history via
`suggest_posting_windows`. Never fabricate a schedule.

## Workflow

1. Call `suggest_posting_windows` once.
2. If it returns windows, explain each with its basis (which measured posts
   support it) and label it as derived from a small sample when the sample is
   small.
3. If it returns insufficient data, say exactly that and what is missing
   (published posts with timestamps). Do not substitute generic best practices
   as if they were this workspace's data.

## Boundaries

- Windows are proposals for the operator. Scheduling or publishing still runs
  through the normal proposal and approval flow.
